// Orca is the one shared room, the orchestrator.
// It is the only actor that keeps the averaged model.
// One phone call runs at a time. Fields marked @Persisted are saved
// before the call returns, so a restart keeps the weights.
//
// Example: two phones each send "I moved the weights by this much."
// closeRound adds the token-weighted average onto the saved weights
// and bumps the version from 4 to 5.

import { Actor, type ActorSocket, Ephemeral, Persisted } from "terse-sdk/actor"

const ROUND_MS = 12_000
const GRACE_MS = 3_000
const QUORUM = 1

type LossPoint = { version: number; avgLoss: number }
type Note = { at: number; from: string; text: string; versionMark?: number }
type Seat = { id: string; name: string }
type Offering = { delta: Float32Array; tokens: number; loss: number; name: string }
type Metadata = { name: string; role?: "phone" | "screen" }
type PhoneLive = { id: string; name: string; loss: number | null; tokens: number; offered: boolean }
type SavePhone = { name: string; tokens: number; loss: number }
type LastSave = { version: number; avgLoss: number; phones: SavePhone[] }
type Incoming =
    | { type: "loss"; loss: number; tokens: number }
    | { type: "publish"; deltaB64: string; tokens: number; loss: number; baseVersion: number }

type RoomView = {
    type: "hello" | "pulse" | "round" | "submit" | "reject"
    roomId: string
    version: number
    weightsB64: string
    lossHistory: LossPoint[]
    avgLoss: number | null
    messages: Note[]
    clients: Seat[]
    phones: PhoneLive[]
    lastSave: LastSave | null
    deadlineMs: number
    submissions: number
    quorum: number
    reason?: string
    clientId?: string
}

type SavedRoom = {
    version: number
    weightsB64: string
    lossHistory: LossPoint[]
    messages: Note[]
    spokenVersion: number
    lastSave?: LastSave | null
}

// Turn the base64 string phones send back into a list of weights.
function decodeF32(encoded: string): Float32Array {
    if (!encoded) return new Float32Array(0)
    const bytes = Buffer.from(encoded, "base64")
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
}

// Pack a list of weights into base64 so it can sit in a saved text field.
function encodeF32(values: Float32Array): string {
    return Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString("base64")
}

// new weights = old weights + (tokens-weighted average of the changes).
// Example: old is [10, 10]. One phone (3 tokens) adds [1, 0].
// Another (1 token) adds [0, 2]. Result is [10.75, 10.5].
function applyAverage(weights: Float32Array, offerings: Offering[]): Float32Array {
    const width = offerings[0].delta.length
    const base = weights.length === width ? new Float32Array(weights) : new Float32Array(width)
    let tokenSum = 0
    for (const offering of offerings) tokenSum += offering.tokens
    for (let i = 0; i < width; i++) {
        let acc = 0
        for (const offering of offerings) acc += offering.tokens * offering.delta[i]
        base[i] += acc / tokenSum
    }
    return base
}

export class Orca extends Actor<Metadata, Incoming, RoomView> {
    @Persisted version = 0
    @Persisted weightsB64 = ""
    @Persisted lossHistory: LossPoint[] = []
    @Persisted messages: Note[] = []
    @Persisted spokenVersion = -1
    @Persisted deadlineMs = 0
    @Persisted submitSent = false
    @Persisted lastSave: LastSave | null = null
    @Ephemeral offerings: Offering[] = []
    @Ephemeral board: PhoneLive[] = []

    // Read-only copy for the Watcher and the Voice. Does not change the room.
    async snapshot(): Promise<SavedRoom> {
        return {
            version: this.version,
            weightsB64: this.weightsB64,
            lossHistory: this.lossHistory,
            messages: this.messages,
            spokenVersion: this.spokenVersion,
            lastSave: this.lastSave,
        }
    }

    // Copy an older saved room in, but only if this actor is behind it.
    // Example: actor is version 0, the file is version 27, so we load 27.
    async seed(saved: SavedRoom): Promise<number> {
        if (this.weightsB64 && this.version >= saved.version) return this.version
        this.version = saved.version
        this.weightsB64 = saved.weightsB64
        this.lossHistory = saved.lossHistory
        this.messages = saved.messages
        this.spokenVersion = saved.spokenVersion
        await this.arm(Date.now() + ROUND_MS)
        return this.version
    }

    // Add one line to the transcript and remember which round the Voice has answered.
    // Reassign the array. Pushing onto it would change memory and not the save.
    async recordLine(from: string, text: string, spokenVersion: number): Promise<void> {
        this.messages = [...this.messages, { at: Date.now(), from, text }].slice(-40)
        this.spokenVersion = spokenVersion
        this.broadcast(await this.full("pulse"))
    }

    // A phone joined. Send it the full weights, and tell everyone else the seat list changed.
    async onConnect(socket: Socket): Promise<void> {
        await this.ensureClock()
        socket.send(await this.full("hello", true, { clientId: socket.id }))
        this.broadcast(await this.full("pulse"), { except: socket })
    }

    // A phone left. Broadcast the new seat list. Weights stay.
    async onDisconnect(socket: Socket): Promise<void> {
        this.broadcast(await this.full("pulse"), { except: socket })
    }

    // A phone sent either a live loss or a weight change. One message at a time.
    async onMessage(socket: Socket, message: Incoming): Promise<void> {
        switch (message.type) {
            case "loss":
                await this.noteLoss(socket, message.loss, message.tokens)
                return
            case "publish":
                await this.acceptOffering(socket, message)
                return
            default: {
                const unreachable: never = message
                throw new Error(`unknown message ${JSON.stringify(unreachable)}`)
            }
        }
    }

    // The clock for a 12 second round. At 9 seconds, ask phones to send.
    // At 12 seconds, average whatever arrived, or start a fresh round if nobody did.
    async onAlarm(): Promise<void> {
        const now = Date.now()
        if (!this.submitSent && now >= this.deadlineMs - GRACE_MS) {
            this.submitSent = true
            this.broadcast(await this.full("submit"))
            this.alarm.set(this.deadlineMs)
            return
        }
        if (now >= this.deadlineMs) {
            if (this.offerings.length > 0) {
                await this.closeRound()
                this.broadcast(await this.full("round", true))
                return
            }
            await this.arm(now + ROUND_MS)
            this.broadcast(await this.full("pulse"))
        }
    }

    // Start the round clock if it was never set, or if a restart left it in the past.
    private async ensureClock(): Promise<void> {
        const due = this.alarm.get()
        if (this.deadlineMs === 0 || this.deadlineMs <= Date.now() || due === null) {
            await this.arm(Date.now() + ROUND_MS)
        }
    }

    // Remember when this round ends, and wake the actor 3 seconds before that.
    private async arm(deadlineMs: number): Promise<void> {
        this.deadlineMs = deadlineMs
        this.submitSent = false
        this.alarm.set(deadlineMs - GRACE_MS)
    }

    // Write one "this phone's loss is 4.2" line per version, then refresh the page.
    private async noteLoss(socket: Socket, loss: number, tokens: number): Promise<void> {
        if (!(tokens > 0) || typeof loss !== "number") return
        const already = this.messages.some((note) => note.from === "The Watcher" && note.versionMark === this.version)
        if (!already) {
            const name = socket.metadata.name || "a phone"
            this.messages = [...this.messages, {
                at: Date.now(),
                from: "The Watcher",
                versionMark: this.version,
                text: `${name} is in the circle. Loss ${loss.toFixed(3)} on this step.`,
            }].slice(-40)
        }
        await this.remember(socket, { loss, tokens })
        this.broadcast(await this.full("pulse"))
    }

    // A phone's weight change arrives over HTTP. The socket path drops a full
    // 36,096-weight payload, so the page posts it here instead.
    async submitChange(message: { name: string; deltaB64: string; tokens: number; loss: number; baseVersion: number }): Promise<{ accepted: boolean; version: number; reason: string; weightsB64: string }> {
        const before = this.version
        const result = await this.takeOffering(message.name || "a phone", message)
        const closed = this.version !== before
        if (closed) this.broadcast(await this.full("round", true))
        else this.broadcast(await this.full("pulse"))
        return { accepted: closed, version: this.version, reason: result.reason, weightsB64: closed ? this.weightsB64 : "" }
    }

    // Accept a phone's weight change if it matches this version and this model size.
    // One offering is enough (quorum is 1), so the round usually closes here.
    private async acceptOffering(socket: Socket, message: Extract<Incoming, { type: "publish" }>): Promise<void> {
        const before = this.version
        const result = await this.takeOffering(socket.metadata.name || "a phone", message, socket)
        if (!result.accepted) {
            socket.send(await this.full("reject", true, { reason: result.reason }))
            return
        }
        if (this.version !== before) this.broadcast(await this.full("round", true))
        else this.broadcast(await this.full("pulse"))
    }

    // Check one change, mix it in when the round has enough, and say what happened.
    private async takeOffering(name: string, message: { deltaB64: string; tokens: number; loss: number; baseVersion: number }, socket?: Socket): Promise<{ accepted: boolean; version: number; reason: string }> {
        if (message.baseVersion !== this.version) {
            return { accepted: false, version: this.version, reason: `the room is on version ${this.version}` }
        }
        const delta = decodeF32(message.deltaB64)
        const have = decodeF32(this.weightsB64)
        if (delta.length === 0 || !(message.tokens > 0) || typeof message.loss !== "number") {
            return { accepted: false, version: this.version, reason: "offering is incomplete" }
        }
        if (have.length !== 0 && delta.length !== have.length) {
            return { accepted: false, version: this.version, reason: `offering length ${delta.length} does not match the room` }
        }
        this.offerings = [...this.offerings, { delta, tokens: message.tokens, loss: message.loss, name }]
        if (socket) await this.remember(socket, { offered: true, tokens: message.tokens, loss: message.loss })
        else this.board = this.board.map((row) => row.name === name ? { ...row, offered: true, tokens: message.tokens, loss: message.loss } : row)
        if (this.offerings.length >= QUORUM) await this.closeRound()
        return { accepted: true, version: this.version, reason: "" }
    }

    // Mix the offerings into the saved weights, write the mean loss, and open the next round.
    private async closeRound(): Promise<void> {
        const have = decodeF32(this.weightsB64)
        const next = applyAverage(have, this.offerings)
        const avgLoss = this.offerings.reduce((sum, offering) => sum + offering.loss, 0) / this.offerings.length
        const closed = this.version
        this.lastSave = {
            version: closed,
            avgLoss,
            phones: this.offerings.map((offering) => ({
                name: offering.name,
                tokens: offering.tokens,
                loss: offering.loss,
            })),
        }
        this.board = this.board.map((row) => ({ ...row, offered: false, tokens: 0 }))
        this.lossHistory = [...this.lossHistory, { version: closed, avgLoss }]
        this.messages = [...this.messages, {
            at: Date.now(),
            from: "The Watcher",
            text: `Version ${closed} closes. Mean loss ${avgLoss.toFixed(3)}, from ${this.offerings.length} offering${this.offerings.length === 1 ? "" : "s"}.`,
        }].slice(-40)
        this.weightsB64 = encodeF32(next)
        this.version = closed + 1
        this.offerings = []
        await this.arm(Date.now() + ROUND_MS)
    }

    // Build the JSON the page draws. Weights are included only on hello and on a finished round.
    private async full(type: RoomView["type"], includeWeights = false, extra?: Partial<RoomView>): Promise<RoomView> {
        const last = this.lossHistory.at(-1)
        const sockets = await this.getConnections()
        const seats = sockets
            .filter((socket) => socket.metadata.role !== "screen")
            .map((socket) => ({ id: socket.id, name: socket.metadata.name || "phone" }))
        this.board = seats.map((seat) => {
            const prev = this.board.find((row) => row.id === seat.id)
            return prev
                ? { ...prev, name: seat.name }
                : { id: seat.id, name: seat.name, loss: null, tokens: 0, offered: false }
        })
        return {
            type,
            roomId: this.id,
            version: this.version,
            weightsB64: includeWeights ? this.weightsB64 : "",
            lossHistory: this.lossHistory,
            avgLoss: last ? last.avgLoss : null,
            messages: this.messages,
            clients: seats,
            phones: this.board,
            lastSave: this.lastSave,
            deadlineMs: this.deadlineMs,
            submissions: this.offerings.length,
            quorum: QUORUM,
            ...extra,
        }
    }

    // Keep one live row per phone that is still connected.
    private async remember(socket: Socket, patch: Partial<PhoneLive>): Promise<void> {
        const view = await this.full("pulse")
        this.board = view.phones.map((row) => row.id === socket.id ? { ...row, ...patch, name: socket.metadata.name || row.name } : row)
    }
}

type Socket = ActorSocket<Metadata, RoomView>

// One Worker actor per phone. Orca is the orchestrator. A Worker only remembers that phone.
type WorkerIncoming =
    | { type: "progress"; loss: number; step: number }
    | { type: "checkpoint"; weightsB64: string; loss: number; step: number }

type WorkerView = {
    type: "worker"
    workerId: string
    name: string
    lastLoss: number | null
    lastStep: number
    roundsSent: number
    hasWeights: boolean
}

export class Worker extends Actor<Metadata, WorkerIncoming, WorkerView> {
    @Persisted name = ""
    @Persisted lastLoss: number | null = null
    @Persisted lastStep = 0
    @Persisted roundsSent = 0
    @Persisted lastWeightsB64 = ""

    // What this phone last saved. Used when it reconnects.
    async snapshot(): Promise<WorkerView> {
        return await this.card()
    }

    // A phone opened its own actor. Tell it the step and loss from last time.
    async onConnect(socket: ActorSocket<Metadata, WorkerView>): Promise<void> {
        if (socket.metadata.name) this.name = socket.metadata.name
        socket.send(await this.card())
    }

    // Either a live step, or the weights at the end of a round.
    async onMessage(socket: ActorSocket<Metadata, WorkerView>, message: WorkerIncoming): Promise<void> {
        switch (message.type) {
            case "progress":
                if (typeof message.loss !== "number" || !(message.step >= 0)) return
                this.lastLoss = message.loss
                this.lastStep = message.step
                socket.send(await this.card())
                return
            case "checkpoint":
                if (!message.weightsB64 || typeof message.loss !== "number") return
                this.lastWeightsB64 = message.weightsB64
                this.lastLoss = message.loss
                this.lastStep = message.step
                this.roundsSent += 1
                socket.send(await this.card())
                return
            default: {
                const unreachable: never = message
                throw new Error(`unknown worker message ${JSON.stringify(unreachable)}`)
            }
        }
    }

    private async card(): Promise<WorkerView> {
        return {
            type: "worker",
            workerId: this.id,
            name: this.name,
            lastLoss: this.lastLoss,
            lastStep: this.lastStep,
            roundsSent: this.roundsSent,
            hasWeights: this.lastWeightsB64.length > 0,
        }
    }
}

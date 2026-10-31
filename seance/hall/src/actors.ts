import { Actor, type ActorSocket, Ephemeral, Persisted } from "durable-actors"

const ROUND_MS = 12_000
const GRACE_MS = 3_000
const QUORUM = 1

type LossPoint = { version: number; avgLoss: number }
type Note = { at: number; from: string; text: string; versionMark?: number }
type Spirit = { id: string; name: string }
type Offering = { delta: Float32Array; tokens: number; loss: number }
type Metadata = { name: string }
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
    clients: Spirit[]
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
}

function decodeF32(encoded: string): Float32Array {
    if (!encoded) return new Float32Array(0)
    const bytes = Buffer.from(encoded, "base64")
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
}

function encodeF32(values: Float32Array): string {
    return Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString("base64")
}

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

export class TrainingRoom extends Actor<Metadata, Incoming, RoomView> {
    @Persisted version = 0
    @Persisted weightsB64 = ""
    @Persisted lossHistory: LossPoint[] = []
    @Persisted messages: Note[] = []
    @Persisted spokenVersion = -1
    @Persisted deadlineMs = 0
    @Persisted submitSent = false
    @Ephemeral offerings: Offering[] = []

    async snapshot(): Promise<SavedRoom> {
        return {
            version: this.version,
            weightsB64: this.weightsB64,
            lossHistory: this.lossHistory,
            messages: this.messages,
            spokenVersion: this.spokenVersion,
        }
    }

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

    async recordLine(from: string, text: string, spokenVersion: number): Promise<void> {
        this.messages = [...this.messages, { at: Date.now(), from, text }].slice(-40)
        this.spokenVersion = spokenVersion
        this.broadcast(await this.full("pulse"))
    }

    async onConnect(socket: Socket): Promise<void> {
        await this.ensureClock()
        socket.send(await this.full("hello", true, { clientId: socket.id }))
        this.broadcast(await this.full("pulse"), { except: socket })
    }

    async onDisconnect(socket: Socket): Promise<void> {
        this.broadcast(await this.full("pulse"), { except: socket })
    }

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

    private async ensureClock(): Promise<void> {
        const due = this.alarm.get()
        if (this.deadlineMs === 0 || this.deadlineMs <= Date.now() || due === null) {
            await this.arm(Date.now() + ROUND_MS)
        }
    }

    private async arm(deadlineMs: number): Promise<void> {
        this.deadlineMs = deadlineMs
        this.submitSent = false
        this.alarm.set(deadlineMs - GRACE_MS)
    }

    private async noteLoss(socket: Socket, loss: number, tokens: number): Promise<void> {
        if (!(tokens > 0) || typeof loss !== "number") return
        const already = this.messages.some((note) => note.from === "The Watcher" && note.versionMark === this.version)
        if (!already) {
            const name = socket.metadata.name || "a spirit"
            this.messages = [...this.messages, {
                at: Date.now(),
                from: "The Watcher",
                versionMark: this.version,
                text: `${name} is in the circle. Loss ${loss.toFixed(3)} on this step.`,
            }].slice(-40)
        }
        this.broadcast(await this.full("pulse"))
    }

    private async acceptOffering(socket: Socket, message: Extract<Incoming, { type: "publish" }>): Promise<void> {
        if (message.baseVersion !== this.version) {
            socket.send(await this.full("reject", true, { reason: `the room is on version ${this.version}` }))
            return
        }
        const delta = decodeF32(message.deltaB64)
        const have = decodeF32(this.weightsB64)
        if (delta.length === 0 || !(message.tokens > 0) || typeof message.loss !== "number") {
            socket.send(await this.full("reject", false, { reason: "offering is incomplete" }))
            return
        }
        if (have.length !== 0 && delta.length !== have.length) {
            socket.send(await this.full("reject", false, { reason: `offering length ${delta.length} does not match the room` }))
            return
        }
        this.offerings = [...this.offerings, { delta, tokens: message.tokens, loss: message.loss }]
        if (this.offerings.length >= QUORUM) {
            await this.closeRound()
            this.broadcast(await this.full("round", true))
            return
        }
        this.broadcast(await this.full("pulse"))
    }

    private async closeRound(): Promise<void> {
        const have = decodeF32(this.weightsB64)
        const next = applyAverage(have, this.offerings)
        const avgLoss = this.offerings.reduce((sum, offering) => sum + offering.loss, 0) / this.offerings.length
        const closed = this.version
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

    private async full(type: RoomView["type"], includeWeights = false, extra?: Partial<RoomView>): Promise<RoomView> {
        const last = this.lossHistory.at(-1)
        const sockets = await this.getConnections()
        return {
            type,
            roomId: this.id,
            version: this.version,
            weightsB64: includeWeights ? this.weightsB64 : "",
            lossHistory: this.lossHistory,
            avgLoss: last ? last.avgLoss : null,
            messages: this.messages,
            clients: sockets.map((socket) => ({ id: socket.id, name: socket.metadata.name || "spirit" })),
            deadlineMs: this.deadlineMs,
            submissions: this.offerings.length,
            quorum: QUORUM,
            ...extra,
        }
    }
}

type Socket = ActorSocket<Metadata, RoomView>

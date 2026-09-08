import {Cache} from './cache'
import mongoose, { Model, Schema } from 'mongoose'
import {LibraryInfo} from '../extension-points/registrar'

const LibraryVersionSchema = new Schema({
    version: String,
    timestamp: Number,
    licenses: Schema.Types.Mixed,
    downloads: Number,
    latest: Boolean,
})

const VulnerabilitySchema = new Schema({
    severity: String,
    score: Number,
    description: String,
    summary: String,
    timestamp: Number,
    permalink: String,
    identifiers: [Schema.Types.Mixed],
    references: [Schema.Types.Mixed],
    vulnerableRange: String,
    vulnerableVersions: String,
    firstPatchedVersion: String,
})

const LibraryInfoSchema = new Schema({
    _id: String,
    name: { type: String, required: true },
    description: String,
    versions: [LibraryVersionSchema],
    licenses: [String],
    keywords: [String],
    issuesUrl: [String],
    reposUrl: [String],
    homepageUrl: [String],
    documentationUrl: [String],
    packageUrl: [String],
    downloads: Number,
    authors: [String],
    vulnerabilities: [VulnerabilitySchema],
    requiresLicenseAcceptance: Boolean,
}, {timestamps: true})

export const LibraryInfoModel: Model<LibraryInfo> = mongoose.model<LibraryInfo>('LibraryInfo', LibraryInfoSchema)

const MONGO_USER = process.env.MONGO_USER ?? 'root'
const MONGO_PASSWORD = process.env.MONGO_PASSWORD ?? 'secret'
const DATABASE_NAME = 'depinder'
const MONGO_URI = process.env.MONGO_URI ?? `mongodb://localhost:27018/${DATABASE_NAME}`

export const mongoCache: Cache = {
    async get(key: string) {
        return await LibraryInfoModel.findById(key).exec()
    },
    async set(key: string, value: any) {
        await LibraryInfoModel.findByIdAndUpdate(key, value, { upsert: true }).exec()
    },
    async has(key: string) {
        return (await LibraryInfoModel.exists({ _id: key }) !== null)
    },
    async load() {
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(MONGO_URI, {
                dbName: DATABASE_NAME,
                user: MONGO_USER,
                pass: MONGO_PASSWORD,
                authSource: 'admin',
            })
        }
    },
    /**
     * Nothing to do: every `set` is an awaited upsert, so the cache is already durable. The
     * mid-run checkpoint must NOT fall back to `write` here — that closes the connection, and
     * every lookup for the rest of the run would then fail against a disconnected mongoose.
     */
    async flush() {
        // Intentionally empty; see the comment above.
    },
    async write() {
        if (mongoose.connection.readyState === 1) {
            await mongoose.disconnect()
        }
    },
}
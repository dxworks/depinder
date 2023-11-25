import {Cache} from './cache'
import mongoose, { Model, Schema } from 'mongoose'
import {Project} from '../../core/project'
import {LibraryInfo} from '../../core/library'

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

const DependencySchema = new Schema({
    _id: String,
    name: String,
    version: String,
    type: String,
    directDep: Boolean,
    requestedBy: [String],
    vulnerabilities: Boolean,
    outOfSupport: Boolean,
    outdated: Boolean,
})

const SystemSchema = new Schema({
    _id: String,
    name: String,
    projectPath: String,
    projects: [String],
})

const ProjectInfoSchema = new Schema({
    _id: String,
    projectPath: String,
    name: String,
    directDeps: Number,
    indirectDeps: Number,
    directOutdatedDeps: Number,
    directOutdatedDepsPercentage: Number,
    indirectOutdatedDeps: Number,
    indirectOutdatedDepsPercentage: Number,
    directVulnerableDeps: Number,
    indirectVulnerableDeps: Number,
    directOutOfSupport: Number,
    indirectOutOfSupport: Number,
    dependencies: [DependencySchema],
})

export const LibraryInfoModel: Model<LibraryInfo> = mongoose.model<LibraryInfo>('LibraryInfo', LibraryInfoSchema)

export const ProjectInfoModel: Model<Project> = mongoose.model<Project>('ProjectInfo', ProjectInfoSchema)

export const SystemInfoModel: Model<Project> = mongoose.model<Project>('SystemInfo', SystemSchema)

const MONGO_USER = process.env.MONGO_USER ?? 'root'
const MONGO_PASSWORD = process.env.MONGO_PASSWORD ?? 'secret'
const DATABASE_NAME = 'depinder'
const MONGO_URI = process.env.MONGO_URI ?? `mongodb://localhost:27018/${DATABASE_NAME}`

export const mongoCacheLibrary: Cache = {
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
    async write() {
        if (mongoose.connection.readyState === 1) {
            await mongoose.disconnect()
        }
    },
    async getAll() {
        return await LibraryInfoModel.find().exec()
    },
}

export const mongoCacheProject: Cache = {
    async get(key: string) {
        return await ProjectInfoModel.findById(key).exec()
    },
    async set(key: string, value: any) {
        await ProjectInfoModel.findByIdAndUpdate(key, value, { upsert: true }).exec()
    },
    async has(key: string) {
        return (await ProjectInfoModel.exists({ _id: key }) !== null)
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
    async write() {
        if (mongoose.connection.readyState === 1) {
            await mongoose.disconnect()
        }
    },
    async getAll() {
        return await ProjectInfoModel.find().exec()
    },
}

export const mongoCacheSystem: Cache = {
    async get(key: string) {
        return await SystemInfoModel.findById(key).exec()
    },
    async set(key: string, value: any) {
        await SystemInfoModel.findByIdAndUpdate(key, value, { upsert: true }).exec()
    },
    async has(key: string) {
        return (await SystemInfoModel.exists({ _id: key }) !== null)
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
    async write() {
        if (mongoose.connection.readyState === 1) {
            await mongoose.disconnect()
        }
    },
    async getAll() {
        return await SystemInfoModel.find().exec()
    },
}
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LibrariesIORegistrar = exports.AbstractRegistrar = void 0;
const node_fetch_1 = __importDefault(require("node-fetch"));
const moment_1 = __importDefault(require("moment/moment"));
const utils_1 = require("../utils/utils");
class AbstractRegistrar {
    constructor(next = null) {
        this.next = null;
        this.next = next;
    }
    async retrieve(libraryName) {
        try {
            return await this.retrieveFromRegistry(libraryName);
        }
        catch (e) {
            if (this.next) {
                return this.next.retrieve(libraryName);
            }
            else
                throw e;
        }
    }
}
exports.AbstractRegistrar = AbstractRegistrar;
class LibrariesIORegistrar extends AbstractRegistrar {
    constructor(registryType) {
        super();
        this.registryType = registryType;
    }
    async retrieveFromRegistry(libraryName) {
        await (0, utils_1.delay)(500);
        const librariesIoURL = `https://libraries.io/api/${this.registryType}/${libraryName}?api_key=${process.env.LIBRARIES_IO_API_KEY}`;
        const librariesIoResponse = await (0, node_fetch_1.default)(librariesIoURL);
        const libIoData = await librariesIoResponse.json();
        return {
            name: libraryName,
            versions: libIoData.versions.map((it) => {
                return {
                    version: it.number,
                    timestamp: (0, moment_1.default)(it.published_at).valueOf(),
                    latest: it.number === libIoData.latest_release_number,
                    licenses: [],
                };
            }),
            description: libIoData?.description ?? '',
            licenses: libIoData.licenses ? [libIoData.licenses] : [],
            homepageUrl: libIoData?.homepage ?? '',
            keywords: libIoData?.keywords ?? [],
            reposUrl: libIoData?.repository_url ? [libIoData.repository_url] : [],
        };
    }
}
exports.LibrariesIORegistrar = LibrariesIORegistrar;

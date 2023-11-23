"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPackagistStats = exports.getPackageDetails = exports.getPackageMetadata = void 0;
const axios_1 = __importDefault(require("axios"));
/**
 * Checkout "Using the Composer metadata" @ {@link https://packagist.org/apidoc#get-package-data} for more info.
 *
 * @param vp VendorPackageInput
 * @param ifModifiedSince If included the endpoint only returns data
 * if it has changed since this date stamp in time.
 *
 */
async function getPackageMetadata(vp, ifModifiedSince = '') {
    try {
        const response = await axios_1.default.get(`https://repo.packagist.org/p/${constructVPString(vp)}.json`, {
            headers: { 'if-modified-since': ifModifiedSince },
        });
        return { data: response.data, lastModified: response.headers['last-modified'] };
    }
    catch (e) {
        if (e && e.response && e.response.status === 304) {
            return { data: {}, lastModified: e.response.headers['last-modified'] };
        }
        throw e;
    }
}
exports.getPackageMetadata = getPackageMetadata;
/**
 * Checkout "Using the API" @ {@link https://packagist.org/apidoc#get-package-data} for more info.
 */
async function getPackageDetails(vp) {
    console.log(`Getting info for ${vp}`);
    try {
        const response = await axios_1.default.get(`https://packagist.org/packages/${constructVPString(vp)}.json`);
        return response?.data?.package;
    }
    catch (e) {
        console.warn(`Packagist could not find package ${constructVPString(vp)}`);
        console.error(e.message, e.stack);
        throw e;
    }
}
exports.getPackageDetails = getPackageDetails;
function constructVPString(vp) {
    if (typeof vp === 'string') {
        return vp;
    }
    else if (typeof vp === 'object') {
        return `${vp.vendor}/${vp.package}`;
    }
    else {
        throw Error('Requires string ("[vendor]/[package]") or object({vendor: [vendor], package: [package]})');
    }
}
/**
 * Checkout {@link https://packagist.org/apidoc#get-statistics} for more info.
 */
async function getPackagistStats() {
    const response = await axios_1.default.get('https://packagist.org/statistics.json');
    return response.data;
}
exports.getPackagistStats = getPackagistStats;

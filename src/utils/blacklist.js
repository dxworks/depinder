"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.blacklistedGlobs = void 0;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const blacklistFile = path_1.default.join(process.cwd(), '.blacklist');
exports.blacklistedGlobs = fs_1.default.existsSync(blacklistFile) ?
    fs_1.default.readFileSync(blacklistFile).toString().split('\n').filter(it => it.trim() !== '' && !it.startsWith('#'))
    : [];

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const analyseRoutes_1 = __importDefault(require("../routes/analyseRoutes"));
const libraryRoutes_1 = __importDefault(require("../routes/libraryRoutes"));
const projectRoutes_1 = __importDefault(require("../routes/projectRoutes"));
const systemRoutes_1 = __importDefault(require("../routes/systemRoutes"));
const app = (0, express_1.default)();
const PORT = 3000;
app.use(express_1.default.json());
app.use((0, cors_1.default)());
app.use('/analyse', analyseRoutes_1.default);
app.use('/library', libraryRoutes_1.default);
app.use('/project', projectRoutes_1.default);
app.use('/system', systemRoutes_1.default);
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

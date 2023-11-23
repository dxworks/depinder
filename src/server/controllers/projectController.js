"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAllProjects = exports.getProjectById = void 0;
const mongo_cache_1 = require("../../cache/mongo-cache");
const getProjectById = async (_req, res) => {
    try {
        const id = _req.params.id;
        await mongo_cache_1.mongoCacheProject.load();
        const value = await mongo_cache_1.mongoCacheProject.get(id);
        if (value) {
            res.status(200).send(value);
        }
        else {
            res.status(404).send('Resource not found');
        }
    }
    catch (err) {
        console.error(`Error: ${err}`);
        res.status(500).send('Internal Server Error');
    }
};
exports.getProjectById = getProjectById;
const getAllProjects = async (_req, res) => {
    try {
        await mongo_cache_1.mongoCacheProject.load();
        const value = await mongo_cache_1.mongoCacheProject.getAll();
        res.status(200).json({ data: value });
    }
    catch (err) {
        console.error(`Error: ${err}`);
        res.status(500).send('Internal Server Error');
    }
};
exports.getAllProjects = getAllProjects;

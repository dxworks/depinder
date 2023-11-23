"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultPlugins = void 0;
const javascript_1 = require("../plugins/javascript");
const ruby_1 = require("../plugins/ruby");
const java_1 = require("../plugins/java");
const python_1 = require("../plugins/python");
const dotnet_1 = require("../plugins/dotnet");
const php_1 = require("../plugins/php");
exports.defaultPlugins = [
    javascript_1.javascript,
    ruby_1.ruby,
    java_1.java,
    python_1.python,
    php_1.php,
    dotnet_1.dotnet,
];

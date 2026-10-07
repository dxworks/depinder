#!/usr/bin/env node

import './utils/warnings'
import {mainCommand} from './depinder'

mainCommand
    .parse(process.argv)

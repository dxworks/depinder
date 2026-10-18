import type {Logger as CoreLogger, LogLevel} from '@depinder/core'
import {createLogger, format, transports} from 'winston'
import path from 'path'
import {depinderFolder} from './utils'

const {json, errors, timestamp, prettyPrint, colorize, combine, printf} = format

const simplestFormat = printf(({message}) => {
    return `${message}`
})

export const log = createLogger({
    transports: [
        new transports.Console({
            level: ['dev', 'develop', 'development'].includes(process.env.NODE_ENV || '') ? 'debug' : 'info',
            format: combine(
                colorize({
                    all: true,
                    colors: {
                        info: 'blue',
                        warn: 'yellow',
                        error: 'red',
                        debug: 'grey',
                    },
                }),
                simplestFormat
            ),
        }),
        new transports.File({
            filename: 'depinder.log',
            dirname: path.resolve(depinderFolder),
            format: combine(
                json(),
                errors({stack: true}),
                timestamp(),
                prettyPrint()
            ),
            tailable: false,
        }),
    ],
})

/** Core's `Logger` over the CLI log, so messages from core's fetchers land at their own level. */
export function coreLogger(bindings: Record<string, unknown> = {}): CoreLogger {
    const at = (level: LogLevel) => (message: string, fields?: Record<string, unknown>) => {
        const context = {...bindings, ...fields}
        log.log(level, Object.keys(context).length ? `${message} ${JSON.stringify(context)}` : message)
    }
    return {
        debug: at('debug'),
        info: at('info'),
        warn: at('warn'),
        error: at('error'),
        child: extra => coreLogger({...bindings, ...extra}),
    }
}

import {describe, expect, it} from 'vitest'
import {scannerFailureReason} from '../../src/index.js'

describe('scannerFailureReason', () => {
    it('reads the last failing stderr line, not the scanner\'s progress chatter', () => {
        const reason = scannerFailureReason({
            message: 'Command failed: trivy sbom --format json /x/p.cdx.json\nFATAL\tinit error',
            stderr: 'INFO\tNeed to update DB\nINFO\tDownloading vulnerability DB...\nFATAL\tinit error: DB error: failed to download\n',
        })

        expect(reason).toBe('Command failed: trivy sbom --format json /x/p.cdx.json — FATAL\tinit error: DB error: failed to download')
    })

    it('drops colour escapes from the verdict', () => {
        const reason = scannerFailureReason({
            message: 'exit 1',
            stderr: '\x1b[0000;36m INFO\x1b[0m loading DB\n\x1b[0000;31mERROR\x1b[0m unable to load vulnerability store\n',
        })

        expect(reason).toBe('exit 1 — ERROR unable to load vulnerability store')
    })

    it('falls back to the last stderr line when none mentions a failure', () => {
        expect(scannerFailureReason({message: 'exit 2', stderr: 'starting\nkilled by the OOM reaper\n\n'}))
            .toBe('exit 2 — killed by the OOM reaper')
    })

    it('is the headline alone without stderr', () => {
        expect(scannerFailureReason({message: 'exit 1'})).toBe('exit 1')
        expect(scannerFailureReason({message: 'exit 1', stderr: '  \n'})).toBe('exit 1')
    })
})

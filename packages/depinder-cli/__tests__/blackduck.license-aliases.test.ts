import {licenseColumns, licenseIdentity} from '../src/blackduck/licenses'

/** Licence spellings from the 2026-10-12 comparison run that only an alias reaches, with their package. */
describe('licence aliases', () => {
    it.each([
        ['3-Clause BSD License', 'BSD-3-Clause'],                                   // protobuf
        ['BSD 3-clause New License', 'BSD-3-Clause'],                               // dom4j
        ['BSD New license', 'BSD-3-Clause'],                                        // google-auth-library
        ['Modified BSD', 'BSD-3-Clause'],                                           // jersey-server
        ['ALv2', 'Apache-2.0'],                                                     // pax-url
        ['the Apache License, ASL Version 2.0', 'Apache-2.0'],                      // scalatest
        ['Eclipse Public License v. 2.0', 'EPL-2.0'],                               // jakarta.persistence-api
        ['Eclipse Distribution License v. 1.0', 'EDL-1.0'],                         // jakarta.persistence-api
        ['The Universal Permissive License (UPL), Version 1.0', 'UPL-1.0'],         // oci-java-sdk
        ['Public Domain, per Creative Commons CC0', 'CC0-1.0'],                     // HdrHistogram
        ['W3C-20150513', 'W3C'],                                                    // wicg-inert
        ['GNU Library General Public License v2.1 or later', 'LGPL-2.1-or-later'],  // hibernate-entitymanager
        ['GNU Library or Lesser General Public License (LGPL) V2.1', 'LGPL-2.1'],   // jsqlparser
        ['GPL2 w/ CPE', 'GPL-2.0-with-classpath-exception'],                        // jakarta.*-api
        ['GPLv2+CE', 'GPL-2.0-with-classpath-exception'],                           // javafx-base
        ['GNU General Public License, version 2 with the GNU Classpath Exception',  // jakarta.jms-api
            'GPL-2.0-with-classpath-exception'],
        ['The GNU General Public License (GPL), Version 2, With Classpath Exception', // jersey-server
            'GPL-2.0-with-classpath-exception'],
        ['GNU General Public License (GPL), version 2, with the Classpath exception', // jmh-core
            'GPL-2.0-with-classpath-exception'],
    ])('reads %s as %s', (spelling, id) => {
        expect(licenseIdentity(spelling)).toBe(id)
        expect(licenseColumns([spelling])).toEqual(licenseColumns([id]))
    })
})

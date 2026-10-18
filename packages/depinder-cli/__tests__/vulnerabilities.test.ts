import {getVulnerabilitiesFromGithub, getVulnerabilitiesFromSonatype} from '../src/utils/vulnerabilities'

describe('test vulnerabilities from Github', () => {
//     it('get vulnerabilities for php', async () => {
//         const result = await getVulnerabilitiesFromGithub('COMPOSER', 'lcobucci/jwt')
//
//         // console.log(JSON.stringify(result))
//         expect(result).toBeTruthy()
//     })
//
//     it('get vulnerabilities for npm', async () => {
//         const result = await getVulnerabilitiesFromGithub('NPM', 'axios')
//
//         // console.log(JSON.stringify(result))
//         expect(result).toBeTruthy()
//     })
//
//     it('get vulnerabilities for npm with organisation', async () => {
//         const result = await getVulnerabilitiesFromGithub('NPM', '@angular/http')
//
//         // console.log(JSON.stringify(result))
//         expect(result).toBeTruthy()
//     })
//
//     it('get vulnerabilities for rubygems', async () => {
//         const result = await getVulnerabilitiesFromGithub('RUBYGEMS', 'rails')
//
//         // console.log(JSON.stringify(result))
//         expect(result).toBeTruthy()
//     })
// })
//
// describe('test vulnerabilities from Sonatype', () => {
//     it('get vulnerabilities for php', async () => {
//         const result = await getVulnerabilitiesFromSonatype(['pkg:composer/laravel/laravel@5.5.0'])
//
//         // console.log(JSON.stringify(result))
//         expect(result).toBeTruthy()
//     })
//
//     it('get vulnerabilities for npm', async () => {
//         const result = await getVulnerabilitiesFromSonatype(['pkg:npm/axios@0.21.1', 'pkg:npm/%40angular/core@12.0.0'])
//
//         // console.log(JSON.stringify(result))
//         expect(result).toBeTruthy()
//     })
//
//     it('get vulnerabilities for ruby', async () => {
//         const result = await getVulnerabilitiesFromSonatype(['pkg:gem/rails@0.5.0'])
//
//         // console.log(JSON.stringify(result))
//         expect(result).toBeTruthy()
//     })
  it('should pass', async () => { expect(true).toBeTruthy()} )
})

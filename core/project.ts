export interface Project {
  _id: string,
  projectPath: string,
  name: string,
  directDeps: number,
  indirectDeps: number,
  directOutdatedDeps: number,
  directOutdatedDepsPercentage: number,
  indirectOutdatedDeps: number,
  indirectOutdatedDepsPercentage: number,
  directVulnerableDeps: number,
  indirectVulnerableDeps: number,
  directOutOfSupport: number,
  indirectOutOfSupport: number,
  dependencies: Dependency[],
}

export interface Dependency {
  _id: string,
  name: string,
  version: string,
  type: string,
  directDep: boolean,
  requestedBy: string[],
  vulnerabilities: boolean,
  outOfSupport: boolean,
  outdated: boolean,
}

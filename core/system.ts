export interface System {
  _id: string,
  name: string,
  runs: SystemRun[]
}

export interface SystemRun {
  date: string,
  projects: string[]
}
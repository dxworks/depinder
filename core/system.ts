export interface System {
  _id: string,
  name: string,
  runs: SystemRun[]
}

export interface SystemRun {
  date: number,
  projects: string[]
}

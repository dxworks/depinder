interface DependencyHistory {
  [dependencyName: string]: {
    dependency: string;
    history: StatusEntry[];
  };
}

interface StatusEntry {
  commitOid: string;
  date: string;
  action: "DELETED" | "ADDED" | "MODIFIED";
  fromVersion?: string;
  toVersion?: string;
}

interface DependencyHistory {
  [dependencyName: string]: {
    history: StatusEntry[];
  };
}

interface StatusEntry {
  commitOid: string;
  date: string;
  action: "DELETED" | "ADDED" | "MODIFIED";
  version?: string;        // For ADDED or DELETED actions
  fromVersion?: string;    // Only for MODIFIED action
  toVersion?: string;      // Only for MODIFIED action
}

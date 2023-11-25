import {Dependency} from '../../../../../core/project'

export class TreeNode {
  data: Dependency;
  children: TreeNode[];

  constructor(data: Dependency) {
    this.data = data;
    this.children = [];
  }

  addChild(child: TreeNode): void {
    this.children.push(child);
  }

  contains(name?: string, vulnerabilities?: boolean, outOfSupport?: boolean, outdated?: boolean): boolean {
    const nameMatch = name === undefined || this.data.name.includes(name);

    //todo check why comparisons don't work with boolean
    const vulnerabilitiesMatch = vulnerabilities === undefined || `${this.data.vulnerabilities}` === `${vulnerabilities}`;
    const outOfSupportMatch = outOfSupport === undefined || `${this.data.outOfSupport}` === `${outOfSupport}`;
    const outOfDateMatch = outdated === undefined || `${this.data.outdated}` === `${outdated}`;

    if (nameMatch && vulnerabilitiesMatch && outOfSupportMatch && outOfDateMatch) {
      return true;
    }

    for (let child of this.children) {
      if (child.contains(name, vulnerabilities, outOfSupport, outdated)) {
        return true;
      }
    }

    return false;
  }
}

export class Tree<T> {
  root: TreeNode | null;

  constructor() {
    this.root = null;
  }
}

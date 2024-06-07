import {Component, Input, OnChanges, OnInit, SimpleChanges} from "@angular/core";
import {Dependency} from "@core/project";
import {TreeNode} from "../../models/tree";
import {ProjectsService} from "../../services/projects.service";
import {LibraryInfo} from "@core/library";
import {DependencyFilter} from "../../models/dependency-filter";
import {LibrariesService} from "../../services/libraries.service";
import {DependencyFilterComponent} from "./dependency-filter/dependency-filter.component";
import {
  DependencyRecursiveComponent
} from "../dependency-recursive/dependency-recursive.component";
import {JsonPipe} from "@angular/common";
import {DependencyDetailsComponent} from "./dependency-details/dependency-details.component";
import {MatDialog, MatDialogRef} from "@angular/material/dialog";
import {MatProgressSpinnerModule} from "@angular/material/progress-spinner";

@Component({
  standalone: true,
  selector: 'app-dependencies',
  templateUrl: './dependencies.component.html',
  imports: [
    DependencyFilterComponent,
    DependencyRecursiveComponent,
    JsonPipe,
    DependencyDetailsComponent,
    MatProgressSpinnerModule
  ],
  styleUrl: './dependencies.component.css'
})
export class DependenciesComponent implements OnInit, OnChanges {
  @Input() allDependencies: Dependency[] = [];
  treeNodes: TreeNode[] = [];
  selectedDependency?: Dependency;
  // selectedLibrary?: LibraryInfo;
  filter: DependencyFilter = {
    searchField: undefined,
    filterByVulnerabilities: undefined,
    filterByOutdated: undefined,
    filterByOutOfSupport: undefined,
  };

  constructor(private projectsService: ProjectsService) {}

  ngOnInit(): void {
    this.buildDirectDependencyNodes();
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes["allDependencies"]) {
      this.buildDirectDependencyNodes();
    }
  }

  buildDirectDependencyNodes() {
    this.treeNodes = [];
    // Convert the array into a Map, using _id as the key
    const uniqueDependenciesMap = new Map(this.allDependencies.map(dependency => [`${dependency._id}@${dependency.version}`, dependency]));

    // Convert the Map back into an array
    this.allDependencies = Array.from(uniqueDependenciesMap.values());
    for (let dependency of this.allDependencies) {
      if (dependency.directDep) {
        let directDependencies = this.projectsService.getDependenciesByRequestedBy(
          this.allDependencies,
          `${dependency.name}@${dependency.version}`);

        let rootTreeNode = new TreeNode(dependency);

        let treeNode = this.createTreeNode(rootTreeNode, directDependencies, new Set<string>());

        this.treeNodes.push(treeNode);
      }
    }
  }

  createTreeNode(currentNode: TreeNode, dependencies: Dependency[], dependencyPath: Set<string>): TreeNode {
    for (let dependency of dependencies) {
      // Check if the dependency is already in the path from root to current node
      if (dependencyPath.has(dependency._id)) {
        continue;
      }

      // Add the dependency to the path
      dependencyPath.add(dependency._id);

      let newTreeNode: TreeNode = new TreeNode(dependency);

      let childDependencies = this.projectsService.getDependenciesByRequestedBy(this.allDependencies, dependency.name + '@' + dependency.version);

      // Recursive call with the updated path
      this.createTreeNode(newTreeNode, childDependencies, new Set(dependencyPath));

      // Adding child to the current node
      currentNode.addChild(newTreeNode);

      // Remove the dependency from the path after processing
      dependencyPath.delete(dependency._id);
    }

    return currentNode;
  }

  receiveFilter($event: DependencyFilter) {
    this.filter = $event;
  }
}

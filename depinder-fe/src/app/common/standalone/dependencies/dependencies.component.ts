import {Component, Input, OnInit} from "@angular/core";
import {Dependency} from "@core/project";
import {TreeNode} from "../../models/tree";
import {ProjectsService} from "../../services/projects.service";
import {LibraryInfo} from "@core/library";
import {DependencyFilter} from "../../models/dependency-filter";
import {LibrariesService} from "../../services/libraries.service";
import {DependencyFilterComponent} from "../../../projects/project-details/dependency-filter/dependency-filter.component";
import {
  DependencyRecursiveComponent
} from "../dependency-recursive/dependency-recursive.component";
import {JsonPipe} from "@angular/common";
import {DependencyDetailsComponent} from "./dependency-details/dependency-details.component";

@Component({
  standalone: true,
  selector: 'app-dependencies',
  templateUrl: './dependencies.component.html',
  imports: [
    DependencyFilterComponent,
    DependencyRecursiveComponent,
    JsonPipe,
    DependencyDetailsComponent
  ],
  styleUrl: './dependencies.component.css'
})
export class DependenciesComponent implements OnInit {
  @Input() allDependencies: Dependency[] = [];
  treeNodes: TreeNode[] = [];
  selectedDependency?: Dependency;
  selectedLibrary?: LibraryInfo;
  filter: DependencyFilter = {
    searchField: undefined,
    filterByVulnerabilities: undefined,
    filterByOutdated: undefined,
    filterByOutOfSupport: undefined,
  };
  maxDepth: number = 10;

  constructor(private projectsService: ProjectsService, private librariesService: LibrariesService) {
  }
  ngOnInit(): void {
    this.fetchProject();
  }

  fetchProject() {
    for (let dependency of this.allDependencies) {
      if (dependency.directDep) {
        let testDependencies = this.projectsService.getDependenciesByRequestedBy(
          this.allDependencies,
          `${dependency.name}@${dependency.version}`);

        let testTreeNode = new TreeNode(dependency);

        let testTreeNode2 = this.createTreeNode(
          testTreeNode,
          testDependencies,
          0
        );

        this.treeNodes.push(testTreeNode2);
      }
    }
  }

  createTreeNode(currentDependency: TreeNode, dependencies: Dependency[], depth: number): TreeNode {
    if (depth < this.maxDepth) {
      for (let dependency of dependencies) {

        let currentTreeNode: TreeNode = new TreeNode(dependency);

        let dependencies2 = this.projectsService.getDependenciesByRequestedBy(this.allDependencies, dependency.name + '@' + dependency.version);

        // Recursive call
        this.createTreeNode(currentTreeNode, dependencies2, depth + 1);

        if(depth == 20)
          console.log(dependency._id + ' ' + depth)

        // Adding child to the current node
        currentDependency.addChild(currentTreeNode);
      }
    }

    return currentDependency;
  }

  receiveInfo($event: any) {
    this.selectedDependency = $event;

    if (this.selectedDependency !== undefined) {
      this.librariesService.find(this.selectedDependency?._id).subscribe({
          next: (libraryInfo: LibraryInfo) => {
            this.selectedLibrary = libraryInfo;
            // console.log(this.libraryInfo);
          },
          error: (err: any) => {
            console.error(err);
          }
        }
      );
    }
  }
  receiveFilter($event: DependencyFilter) {
    this.filter = $event;
  }
}

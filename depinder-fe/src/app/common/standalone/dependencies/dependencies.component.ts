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
  selectedLibrary?: LibraryInfo;
  filter: DependencyFilter = {
    searchField: undefined,
    filterByVulnerabilities: undefined,
    filterByOutdated: undefined,
    filterByOutOfSupport: undefined,
  };
  dialogRef?: MatDialogRef<DependencyDetailsComponent, any>;

  constructor(private projectsService: ProjectsService,
              private librariesService: LibrariesService,
              public dialog: MatDialog) {
    this.openDialog = this.openDialog.bind(this);
  }
  ngOnInit(): void {
    this.fetchProject();
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes["allDependencies"]) {
      this.fetchProject();
    }
  }

  fetchProject() {
    this.treeNodes = [];
    // Convert the array into a Map, using _id as the key
    const uniqueDependenciesMap = new Map(this.allDependencies.map(dep => [`${dep._id}@${dep.version}`, dep]));

    // Convert the Map back into an array
    this.allDependencies = Array.from(uniqueDependenciesMap.values());
    for (let dependency of this.allDependencies) {
      if (dependency.directDep) {
        let testDependencies = this.projectsService.getDependenciesByRequestedBy(
          this.allDependencies,
          `${dependency.name}@${dependency.version}`);

        let testTreeNode = new TreeNode(dependency);

        let testTreeNode2 = this.createTreeNode(testTreeNode, testDependencies, new Set<string>());

        this.treeNodes.push(testTreeNode2);
      }
    }
  }

  createTreeNode(currentDependency: TreeNode, dependencies: Dependency[], path: Set<string>): TreeNode {
    for (let dependency of dependencies) {
      // Check if the dependency is already in the path from root to current node
      if (path.has(dependency._id)) {
        continue;
      }

      // Add the dependency to the path
      path.add(dependency._id);

      let currentTreeNode: TreeNode = new TreeNode(dependency);

      let dependencies2 = this.projectsService.getDependenciesByRequestedBy(this.allDependencies, dependency.name + '@' + dependency.version);

      // Recursive call with the updated path
      this.createTreeNode(currentTreeNode, dependencies2, new Set(path));

      // Adding child to the current node
      currentDependency.addChild(currentTreeNode);

      // Remove the dependency from the path after processing
      path.delete(dependency._id);
    }

    return currentDependency;
  }

  receiveInfo($event: any) {
    this.selectedDependency = $event;

    if (this.selectedDependency !== undefined) {
      this.librariesService.find(this.selectedDependency?._id).subscribe({
          next: (libraryInfo: LibraryInfo) => {
            this.selectedLibrary = libraryInfo;
            this.openDialog();
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

  openDialog(): void {
    this.dialogRef = this.dialog.open(DependencyDetailsComponent, {
      width: '80vw',
      height: '60vh',
      data: {
        selectedDependency: this.selectedDependency,
        libraryInfo: this.selectedLibrary,
      }
    });

    this.dialogRef.afterClosed().subscribe(() => {
      this.selectedDependency = undefined;
    });
  }
}

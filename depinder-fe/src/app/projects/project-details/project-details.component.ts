import {Component, OnInit} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { ProjectsService } from "../../common/services/projects.service";
import {animate, state, style, transition, trigger} from "@angular/animations";
import {TreeNode} from "../../common/models/tree";
import {LibrariesService} from "../../common/services/libraries.service";
import {DependencyFilter} from "../../common/models/dependency-filter";
import {Dependency, Project } from '@core/project';
import { LibraryInfo } from '@core/library';

@Component({
  selector: 'app-project-details',
  templateUrl: './project-details.component.html',
  styleUrls: ['./project-details.component.css'],
  animations: [
    trigger('detailExpand', [
      state('collapsed', style({height: '0px', minHeight: '0'})),
      state('expanded', style({height: '*'})),
      transition('expanded <=> collapsed', animate('225ms cubic-bezier(0.4, 0.0, 0.2, 1)')),
    ]),
  ],
})
export class ProjectDetailsComponent implements OnInit {
  projectId = '';
  project!: Project;
  treeNodes: TreeNode[] = [];
  maxDepth: number = 10;
  selectedDependency?: Dependency;
  selectedLibrary?: LibraryInfo;
  value? : string;

  filter: DependencyFilter = {
    searchField: undefined,
    filterByVulnerabilities: undefined,
    filterByOutdated: undefined,
    filterByOutOfSupport: undefined,
  };

  constructor(private projectsService: ProjectsService, private route: ActivatedRoute, private librariesService: LibrariesService) {
  }

  ngOnInit(): void {
    this.route.params.subscribe(params => {
      this.projectId = params['projectId'];
    });

    this.fetchProject();
  }

  fetchProject() {
    this.projectsService.find(this.projectId).subscribe({
      next: async (res: any) => {
        this.project = res;

        for (let dependency of this.project.dependencies) {
          if (dependency.directDep) {
            let testDependencies = this.projectsService.getDependenciesByRequestedBy(
              this.project.dependencies,
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

      },
      error: (error) => {
        console.error('An error occurred:', error);
      }
    });
  }

  createTreeNode(currentDependency: TreeNode, dependencies: Dependency[], depth: number): TreeNode {
    if (depth < this.maxDepth) {
      for (let dependency of dependencies) {

        let currentTreeNode: TreeNode = new TreeNode(dependency);

        let dependencies2 = this.projectsService.getDependenciesByRequestedBy(this.project.dependencies, dependency.name + '@' + dependency.version);

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

import {Component, OnInit} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { ProjectsService } from "../../common/services/projects.service";
import {Dependency, Project } from '@core/project';
import {ToolbarService} from "../../common/services/toolbar.service";

@Component({
  selector: 'app-project-details',
  templateUrl: './project-details.component.html',
  styleUrls: ['./project-details.component.css'],
})
export class ProjectDetailsComponent implements OnInit {
  projectId = '';
  project!: Project;
  dependencies: Dependency[] = [];
  value? : string;

  constructor(private projectsService: ProjectsService, private route: ActivatedRoute, protected toolbarService: ToolbarService) {
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
            this.dependencies.push(...this.projectsService.getDependenciesByRequestedBy(
              this.project.dependencies,
              `${dependency.name}@${dependency.version}`));
          }
        }
      },
      error: (error) => {
        console.error('An error occurred:', error);
      }
    });
  }
}

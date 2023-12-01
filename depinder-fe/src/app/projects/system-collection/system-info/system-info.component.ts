import {Component, Input, OnInit} from '@angular/core'
import { CommonModule } from '@angular/common'
import { ProjectsTableComponent } from '../../../common/standalone/projects-table/projects-table.component'
import {ProjectsService} from '../../../common/services/projects.service'
import {Dependency, Project} from '@core/project';
import {System, SystemRun} from '@core/system';
import {
  DependencyRecursiveComponent
} from "../../../common/standalone/dependency-recursive/dependency-recursive.component";
import {DependenciesComponent} from "../../../common/standalone/dependencies/dependencies.component";
import {SystemsService} from "../../../common/services/systems.service";
import {ActivatedRoute} from "@angular/router";

@Component({
  selector: 'app-system-info',
  standalone: true,
  imports: [CommonModule, ProjectsTableComponent, DependencyRecursiveComponent, DependenciesComponent],
  templateUrl: './system-info.component.html',
  styleUrl: './system-info.component.css'
})
export class SystemInfoComponent implements OnInit{
  projects$: Project[] = [];
  dependencies$: Dependency[] = [];
  system$: System | undefined;
  id: string | undefined;
  constructor(private projectsService: ProjectsService, private systemService: SystemsService, private route: ActivatedRoute) { }

  ngOnInit() {
    this.route.params.subscribe(params => {
      this.id = params['id'];
    });

    console.log('id ' + this.id);

    if (this.id) {
      this.systemService.find(this.id).subscribe(
        (res: any) => {
          this.system$ = res.body;
          console.log('res.body ' + JSON.stringify(res.body));

          console.log('system ' + this.system$);

          if (this.system$ !== undefined) {
            this.system$.runs.sort(
              (a: SystemRun, b) => a.date < b.date ? 1 : -1
            )[0].projects.forEach((projectId, index2) => {
              this.projectsService.find(projectId).subscribe(
                {
                  next: (res2: any) => {
                    this.projects$ = [res2, ...this.projects$]
                    this.dependencies$ = [
                      ...this.dependencies$,
                      ...res2.dependencies
                    ]
                  }
                }
              )
            })
            console.log('projects ' + this.projects$.length);
          }
        }
      )
    }
  }
}

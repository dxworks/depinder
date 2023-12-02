import {Component, OnChanges, OnInit, SimpleChanges} from '@angular/core'
import { CommonModule } from '@angular/common'
import { ProjectsTableComponent } from '../../common/standalone/projects-table/projects-table.component'
import {ProjectsService} from '../../common/services/projects.service'
import {Dependency, Project} from '@core/project';
import {System, SystemRun} from '@core/system';
import {
  DependencyRecursiveComponent
} from "../../common/standalone/dependency-recursive/dependency-recursive.component";
import {DependenciesComponent} from "../../common/standalone/dependencies/dependencies.component";
import {SystemsService} from "../../common/services/systems.service";
import {ActivatedRoute} from "@angular/router";
import {MatFormFieldModule} from "@angular/material/form-field";
import {MatInputModule} from "@angular/material/input";
import {FormsModule} from "@angular/forms";

@Component({
  selector: 'app-system-info',
  standalone: true,
  imports: [CommonModule, ProjectsTableComponent, DependencyRecursiveComponent, DependenciesComponent, MatFormFieldModule, MatInputModule, FormsModule],
  templateUrl: './system-info.component.html',
  styleUrl: './system-info.component.css'
})
export class SystemInfoComponent implements OnInit {
  projects: Project[] = [];
  dependencies: Dependency[] = [];
  system: System | undefined;
  id: string | undefined;
  selectedRun: SystemRun | undefined;
  selectedRunDate: number | undefined;

  constructor(private projectsService: ProjectsService, private systemService: SystemsService, private route: ActivatedRoute) { }

  ngOnInit() {
    this.route.params.subscribe(params => {
      this.id = params['id'];
    });

    if (this.id) {
      this.systemService.find(this.id).subscribe(
        (system: System) => {
          this.system = system;

          if (this.system !== undefined && this.system.runs.length > 0) {
            this.selectedRunDate = this.getLatestRunDate();
            this.getRunData();
          }
        }
      )
    }
  }

  getRunData() {
      this.selectedRun = this.getRunByDate(this.selectedRunDate!);
      this.projects = [];
      this.dependencies = [];
      this.selectedRun.projects.forEach((projectId: string) => {
        this.projectsService.find(projectId).subscribe(
          {
            next: (project: Project) => {
              this.projects = [project, ...this.projects]
              this.dependencies = [...this.dependencies, ...project.dependencies]
            }
          }
        )
      })
    this.dependencies
  }

  getLatestRunDate(): number {
      return this.system!.runs.sort((a, b) => {
        return b.date - a.date;
      })[0].date;
  }

  getRunByDate(date: number): SystemRun {
    return this.system!.runs.filter(run => run.date == date)[0];
  }

  convertToDateString(timestamp: number): Date {
    return new Date(timestamp);
  }
}

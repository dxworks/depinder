import {Component, OnInit} from '@angular/core'
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
import {ActivatedRoute, Router} from "@angular/router";
import {MatFormFieldModule} from "@angular/material/form-field";
import {MatInputModule} from "@angular/material/input";
import {FormsModule} from "@angular/forms";
import {convertToDateString} from "../../common/utils";
import {MatIconModule} from "@angular/material/icon";
import {MatButtonModule} from "@angular/material/button";
import {MatTabsModule} from "@angular/material/tabs";
import {catchError, forkJoin, of, switchMap, tap} from "rxjs";
import {LicenceLabelComponent} from "../../common/standalone/licence-label/licence-label.component";
import {SystemLicences2Component} from "./system-licences-2/system-licences-2.component";
import {MatToolbarModule} from "@angular/material/toolbar";
import {ToolbarService} from "../../common/services/toolbar.service";
import {SystemDashboardComponent} from "./system-dashboard/system-dashboard.component";

@Component({
  selector: 'app-system-info',
  standalone: true,
  imports: [CommonModule, ProjectsTableComponent, DependencyRecursiveComponent, DependenciesComponent, MatFormFieldModule, MatInputModule, FormsModule, MatIconModule, MatButtonModule, MatTabsModule, LicenceLabelComponent, SystemLicences2Component, MatToolbarModule, SystemDashboardComponent],
  templateUrl: './system-info.component.html',
  styleUrl: './system-info.component.css'
})
export class SystemInfoComponent implements OnInit {
  projects: Project[] = [];
  dependencies: Dependency[] = [];
  system?: System;
  id?: string;
  selectedRun?: SystemRun;
  selectedRunDate?: number;

  constructor(private projectsService: ProjectsService,
              private systemService: SystemsService,
              private route: ActivatedRoute,
              protected toolbarService: ToolbarService,
              private router: Router,) { }

  ngOnInit() {
    this.route.params.pipe(
      tap(params => this.id = params['id']),
      switchMap(params => this.id ? this.systemService.find(this.id) : of(null)),
      tap(system => {
        this.system = system ?? undefined;
        if (this.system && this.system.runs.length > 0) {
          this.selectedRunDate = this.getLatestRunDate();
        }
      }),
      switchMap(() => this.selectedRunDate ? this.getRunDataObservable(this.selectedRunDate) : of(null)),
      catchError(error => {
        console.error('Error fetching data', error);
        return of(null); // Handle the error or return a default value
      })
    ).subscribe();
  }

  getRunDataObservable(date: number) {
    this.selectedRun = this.getRunByDate(date);
    this.projects = [];
    this.dependencies = [];

    return forkJoin(this.selectedRun.projects.map(projectId => this.projectsService.find(projectId))).pipe(
      tap(results => {
        this.projects = results;
        this.dependencies = results.flatMap(project => project.dependencies);
      }),
      catchError(error => {
        console.error('Error fetching projects data', error);
        return of([]);
      })
    );
  }

  getRunData() {
    this.selectedRun = this.getRunByDate(this.selectedRunDate!);
    this.projects = [];
    this.dependencies = [];

    const projectObservables = this.selectedRun!.projects.map(projectId => this.projectsService.find(projectId));

    forkJoin(projectObservables).subscribe(results => {
      results.forEach((project: Project) => {
        console.log(project._id);
        this.projects = [project, ...this.projects];
        this.dependencies = [...project.dependencies, ...this.dependencies];
      });
    });
  }

  getLatestRunDate(): number {
      return this.system!.runs.sort((a, b) => {
        return b.date - a.date;
      })[0].date;
  }

  getRunByDate(date: number): SystemRun {
    return this.system!.runs.filter(run => run.date == date)[0];
  }

  updateSystem() {
    console.log(this.system);
    console.log(this.id);
    this.systemService.updateSystem(this.id!, undefined, undefined, undefined, true).subscribe(
      {
        next: () => {
          //refresh page
          window.location.reload();
        }
      }
    )
  }

  get projectIds() {
    return this.projects.map(project => project._id);
  }

  navigateToEdit() {
    this.router.navigate(['edit'], { relativeTo: this.route });
  }

  protected readonly convertToDateString = convertToDateString;
  protected readonly of = of;
}

import {Component, OnInit} from '@angular/core';
import {ProjectsService} from "../common/services/projects.service";
import {MatSnackBar} from "@angular/material/snack-bar";
import {AnalysisService} from "../common/services/analysis.service";
import {Project} from '@core/project'

@Component({
  selector: 'app-all-projects',
  templateUrl: './all-projects.component.html',
  styleUrls: ['./all-projects.component.css']
})
export class AllProjectsComponent implements OnInit {
  projects$: Project[] = [];
  folderPath: string = '';

  constructor(private projectsService: ProjectsService,
              private analysisService: AnalysisService,
              private _snackBar: MatSnackBar) {
  }

  ngOnInit() {
    this.fetchProjects();
  }

  async fetchProjects() {
    this.projectsService.all().subscribe((res: any) => {
      this.projects$ = res.body['data'];
    });
  }

  async analyse(path: string) {
      this.analysisService.analyse(path).subscribe({
        next: (res: any) => {
          this.openSnackBar(`Status code ${res.status}`);
        },
        error: (err) => {
          console.error('Server Error:', err);
          this.openSnackBar('An error occurred while analyzing the project.');
        }
      });

      await this.fetchProjects();
  }

  openSnackBar(message: string) {
    this._snackBar.open(message, undefined, {
      duration: 2000
    });
  }
}

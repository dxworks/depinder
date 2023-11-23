import {Component, OnInit} from '@angular/core';
import {ProjectsService} from "../common/services/projects.service";
import {Project} from "../common/models/project";
import {MatSnackBar} from "@angular/material/snack-bar";
import {AnalysisService} from "../common/services/analysis.service";

@Component({
  selector: 'app-projects',
  templateUrl: './projects.component.html',
  styleUrls: ['./projects.component.css']
})
export class ProjectsComponent implements OnInit {
  projects$: Project[] = [];
  folderPath: string = '';

  constructor(private projectsService: ProjectsService, private analysisService: AnalysisService, private _snackBar: MatSnackBar) {
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

import {Component, Input} from '@angular/core';
import { CommonModule } from '@angular/common';
import {MatTableModule} from "@angular/material/table";
import {Router} from "@angular/router";
import { Project } from '@core/project';
import {extractorFiles, fileToPackageManager} from "@core/constants";

@Component({
  selector: 'app-projects-table',
  //todo remove standalone
  standalone: true,
  imports: [CommonModule, MatTableModule],
  templateUrl: './projects-table.component.html',
  styleUrl: './projects-table.component.css'
})
export class ProjectsTableComponent {
  @Input() projects: Project[] = [];
  displayedColumns: string[] = ['name',  'project-type', 'package-manager', 'manifest-file', 'lock-file', 'projectPath',];

  constructor(private router: Router) { }

  navigate(projectId: string) {
    this.router.navigate(['/project', projectId]);
  }

  getFile(filePath?: string) {
    if (!filePath) {
      return undefined;
    }
    return filePath.split('/').pop();
  }

  getProjectType(project: Project) {
    const fileName = this.getFile(project.manifestFile ?? project.lockFile);
    const fileExtension = fileName?.split('.').pop();

    if (fileName) {
      for (let [key, fileNames] of extractorFiles.entries()) {
        if (fileNames.includes(fileName) || fileNames.some(name => name === `*.${fileExtension}`)) {
          return key;
        }
      }
    }
    return undefined;
  }

  determinePackageManager(project: Project): string | undefined {
    const fileName = this.getFile(project.lockFile ?? project.manifestFile);

    if (fileName !== undefined) {
      for (let [filePattern, manager] of fileToPackageManager.entries()) {
        if (filePattern.includes('*')) {
          const regex = new RegExp(filePattern.replace('*', '.*') + '$');
          if (regex.test(fileName)) {
            return manager;
          }
        } else if (filePattern === fileName) {
          return manager;
        }
      }
    }
    return undefined;
  }
}

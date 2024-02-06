import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DependenciesComponent } from "../../../common/standalone/dependencies/dependencies.component";
import { Dependency } from "@core/project";
import { SystemsService } from "../../../common/services/systems.service";
import { ProjectsService } from "../../../common/services/projects.service";
import {concatMap, forkJoin, from, toArray} from "rxjs";
import { LibraryInfo } from "@core/library";
import { LibrariesService } from "../../../common/services/libraries.service";
import {Licence} from "@core/licence";
import {LicencesService} from "../../../common/services/licences.service";
import {LicencesComponent} from "../../../all-licences/licences.component";

@Component({
  selector: 'app-system-licences',
  standalone: true,
  imports: [CommonModule, DependenciesComponent, LicencesComponent],
  templateUrl: './system-licences.component.html',
  styleUrl: './system-licences.component.css'
})
export class SystemLicencesComponent implements OnInit {
  dependencies?: Dependency[];
  libraryInfos?: LibraryInfo[] = [];
  licences: Map<string, Licence> = new Map<string, Licence>();
  otherLicences: Map<string, Licence[]> = new Map<string, Licence[]>();

  constructor(
    private systemsService: SystemsService,
    private projectsService: ProjectsService,
    private librariesService: LibrariesService,
    private licencesService: LicencesService,
  ) { }

  get licencesArray(): Licence[] {
    return Array.from(this.licences.values());
  }

  async ngOnInit() {
    const systemId = localStorage.getItem('selectedSystemId');
    const runDate = Number(localStorage.getItem('selectedRunDate'));

    if (systemId && runDate) {
      const system = await this.systemsService.find(systemId).toPromise();

      console.log('system: ' + system);

      const selectedRun = system?.runs.find(run => run.date === runDate);

      if (selectedRun) {
        const projects = await forkJoin(selectedRun.projects.map(projectId => this.projectsService.find(projectId))).toPromise();
        console.log('projects: ' + projects);

        this.dependencies = (projects ?? []).flatMap(project => project.dependencies);

        const libraryObservables = from(this.dependencies).pipe(
          concatMap(dependency => this.librariesService.find(dependency._id)),
          toArray()
        );

        this.libraryInfos = await libraryObservables.toPromise();

        // Load data about the licenses
        (this.libraryInfos ?? []).forEach(libraryInfo => {
          if (libraryInfo && libraryInfo.licenses) {
            libraryInfo.licenses.forEach(license => {
              this.licencesService.getById(license).subscribe(response => {
                if (response.body !== null) {
                  const licenseData: Licence = response.body as Licence;

                  this.licences.set(licenseData._id, licenseData);
                }
                else {
                  this.licencesService.findSimilar(license).subscribe(response => {
                    if (response.body !== null) {
                      const licenseData: Licence[] = response.body as Licence[];

                      this.otherLicences.set(license, licenseData);
                    }
                    else {
                      this.otherLicences.set(license, []);
                    }
                  });
                }
              });
            });
          }
        });
      }
    }
  }

  protected readonly Array = Array;
}

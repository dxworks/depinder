import {Component, Input, OnInit} from '@angular/core';
import { CommonModule } from '@angular/common';
import {Dependency, Project} from "@core/project";
import {LibraryInfo} from "@core/library";
import {Licence} from "@core/licence";
import {MatTableDataSource, MatTableModule} from "@angular/material/table";
import {OperationalRiskDependencies} from "../old-dependencies-table/old-dependencies-table";
import {LicenceRulesService} from "../../../../common/services/licence-rules.service";
import {animate, state, style, transition, trigger} from "@angular/animations";
import {OldDepDetailsComponent} from "../old-dependencies-table/old-dep-details/old-dep-details.component";
import {MatListModule} from "@angular/material/list";
import {MatLineModule} from "@angular/material/core";

interface LicenceIssue {
  licenceID: string,
  projects?: string[],
  libraries: LibraryDisplay[],
  permissions?: string[],
  conditions?: string[],
  limitations?: string[],
  details?: string
}

interface LibraryDisplay {
  projectId: string;
  directLibraries?: LibraryInfo[];
  indirectLibraries: LibraryInfo[];
  seeAllDirectLibraries: boolean;
  seeAllIndirectLibraries: boolean;
}

@Component({
  selector: 'app-licencing-issues',
  standalone: true,
  imports: [CommonModule, MatTableModule, OldDepDetailsComponent, MatListModule, MatLineModule],
  templateUrl: './licencing-issues.component.html',
  styleUrl: './licencing-issues.component.css',
  animations: [
    trigger('detailExpand', [
      state('collapsed,void', style({height: '0px', minHeight: '0'})),
      state('expanded', style({height: '*'})),
      transition('expanded <=> collapsed', animate('225ms cubic-bezier(0.4, 0.0, 0.2, 1)')),
    ]),
  ],
})
export class LicencingIssuesComponent implements OnInit {
  @Input() projects: Project[] = [];
  @Input() libraries?: Map<string, LibraryInfo>;
  @Input() dependencies: Dependency[] = [];
  @Input() licences: any[] = [];

  constructor(private licenceRules: LicenceRulesService) { }

  columns = ['licenceID', 'projects', 'libraries', 'conditions', 'limitations', 'permissions', 'issues'];
  // columns = ['licenceID', 'projects', 'libraries', 'issues'];
  data: LicenceIssue[] = [];
  dataSource!: MatTableDataSource<LicenceIssue>;
  projectIDs: string[] = [];
  expandedElement?: LicenceIssue;

  ngOnInit() {
    this.projectIDs = this.projects.map(project => project._id);

    this.data = this.licences
      .filter(licence => (licence.permissions ?? []).length > 0 && (licence.conditions ?? []).length > 0 && (licence.limitations ?? []).length > 0)
      .map(licence => {
        let licenceLibraries: LibraryDisplay[] = [];  // Declare inside the map function

        this.projects.forEach(project => {
          project.dependencies.forEach(dependency => {
            let library = this.libraries?.get(dependency.name);
            if (library !== undefined && library.licenses.some(libLicence => libLicence === licence._id)) {
              let libraryDisplay = licenceLibraries.find(libraryDisplay => libraryDisplay.projectId === project._id);

              if (libraryDisplay) {
                if (dependency.directDep) {
                  libraryDisplay.directLibraries?.push(library);
                }
                else {
                  libraryDisplay.indirectLibraries.push(library);
                }
              } else {
                if (dependency.directDep) {
                  licenceLibraries.push({
                    projectId: project._id,
                    directLibraries: [library],
                    indirectLibraries: [],
                    seeAllDirectLibraries: false,
                    seeAllIndirectLibraries: false
                  });
                }
                else {
                  licenceLibraries.push({
                    projectId: project._id,
                    directLibraries: [],
                    indirectLibraries: [library],
                    seeAllDirectLibraries: false,
                    seeAllIndirectLibraries: false
                  });
                }
              }
            }
          });
        });

        return {
          licenceID: licence._id,
          permissions: licence.permissions,
          conditions: licence.conditions,
          limitations: licence.limitations,
          libraries: licenceLibraries,
          projects: licenceLibraries.map(libraryDisplay => libraryDisplay.projectId),
        }
      })

    this.data = this.data.filter(licence => this.isCopyleft(licence));

    this.dataSource = new MatTableDataSource<LicenceIssue>(this.data);
  }

  isCopyleft(licence: LicenceIssue): boolean {
    return (licence.conditions?.includes('disclose-source') &&
      licence.conditions?.some(condition => condition.startsWith('same-license')) &&
      licence.conditions?.includes('document-changes')) ?? false;
  }

  protected readonly Array = Array;
}

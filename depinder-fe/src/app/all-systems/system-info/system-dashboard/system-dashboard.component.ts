import {Component, Input, OnChanges, SimpleChanges} from '@angular/core';
import { CommonModule } from '@angular/common';
import {MatExpansionModule} from "@angular/material/expansion";
import {Dependency, Project} from "@core/project";
import {MatTableModule} from "@angular/material/table";
import {OldDependenciesTable} from "./old-dependencies-table/old-dependencies-table";
import {OUT_OF_SUPPORT_MONTHS, OUTDATED_MONTHS} from "@core/constants";
import {VulnerableLibraryVersionsComponent} from "./vulnerable-library-versions/vulnerable-library-versions.component";
import {MatProgressSpinnerModule} from "@angular/material/progress-spinner";
import {MatProgressBarModule} from "@angular/material/progress-bar";
import {concatMap, delay, finalize, from, map, Observable} from "rxjs";
import {LibraryInfo, LibraryVersion} from "@core/library";
import {LibrariesService} from "../../../common/services/libraries.service";

@Component({
  selector: 'app-system-dashboard',
  standalone: true,
  imports: [CommonModule, MatExpansionModule, MatTableModule, OldDependenciesTable, VulnerableLibraryVersionsComponent, MatProgressSpinnerModule, MatProgressBarModule],
  templateUrl: './system-dashboard.component.html',
  styleUrl: './system-dashboard.component.css'
})
export class SystemDashboardComponent implements OnChanges {
  @Input() projects: Project[] = [];
  dependencies: Dependency[] = [];
  libraries?: Map<string, LibraryInfo> = new Map<string, LibraryInfo>();
  loaded = false;

  totalDependencies = 0;
  totalLoaded = 0;

  protected readonly OUTDATED_MONTHS = OUTDATED_MONTHS;
  protected readonly OUT_OF_SUPPORT_MONTHS = OUT_OF_SUPPORT_MONTHS;

  constructor(private libraryService: LibrariesService) {}

  ngOnChanges(changes: SimpleChanges) {
    console.log('ngOnChanges')
    if (changes['projects'].currentValue !== changes['projects'].previousValue && changes['projects'].currentValue.length > 0) {
      this.projects = changes['projects'].currentValue;

      this.projects.forEach(project => {
        project.dependencies.forEach(dependency => {
          this.dependencies.push(dependency);
        });
      });

      this.totalDependencies = this.dependencies.length;

      console.log('getting dependencies')
      this.getDependencies().pipe(
        finalize(() => this.loaded = true)
      ).subscribe(libraries => {
        this.libraries = libraries;
      });
    }
  }

  getOutOfSupport(library: LibraryInfo): boolean {
  let currentDate = new Date();
  let outOfSupportThreshold =  new Date(currentDate.getFullYear(),
    currentDate.getMonth() - OUT_OF_SUPPORT_MONTHS, currentDate.getDate());

    const dependencyDate = new Date(library.versions.find((version: LibraryVersion) => version.latest)!.timestamp);
    return dependencyDate < outOfSupportThreshold;
  }

  getOutDated(library: LibraryInfo): boolean {
    let currentDate = new Date();
    let outdatedThreshold =  new Date(currentDate.getFullYear(),
      currentDate.getMonth() - OUTDATED_MONTHS, currentDate.getDate());
    let outOfSupportThreshold =  new Date(currentDate.getFullYear(),
      currentDate.getMonth() - OUT_OF_SUPPORT_MONTHS, currentDate.getDate());

    const dependencyDate = new Date(library.versions.find((version: LibraryVersion) => version.latest)!.timestamp);
    return dependencyDate < outdatedThreshold && dependencyDate > outOfSupportThreshold;
  }

  getDependencies(): Observable<Map<string, LibraryInfo>> {
    let libraries = new Map<string, LibraryInfo>();

    let observables = this.dependencies.map(dependency => this.libraryService.find(dependency._id).pipe(
      delay(1)
    ));

    return from(observables).pipe(
      concatMap(request => request),
      map((lib: LibraryInfo) => {
        try {
          libraries.set(lib.name, lib);
        }
        catch (e: any) {
          console.warn('Error adding library to map', e)
        }
        this.totalLoaded++;

        return libraries;
      })
    );
  }
}

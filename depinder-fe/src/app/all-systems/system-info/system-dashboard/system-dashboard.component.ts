import {Component, Input} from '@angular/core';
import { CommonModule } from '@angular/common';
import {MatExpansionModule} from "@angular/material/expansion";
import {Dependency, Project} from "@core/project";
import {MatTableModule} from "@angular/material/table";
import {OldDependenciesTable} from "./old-dependencies-table/old-dependencies-table";
import {OUT_OF_SUPPORT_MONTHS, OUTDATED_MONTHS} from "@core/constants";

@Component({
  selector: 'app-system-dashboard',
  standalone: true,
  imports: [CommonModule, MatExpansionModule, MatTableModule, OldDependenciesTable],
  templateUrl: './system-dashboard.component.html',
  styleUrl: './system-dashboard.component.css'
})
export class SystemDashboardComponent {
  @Input() projects: Project[] = [];
  protected readonly OUTDATED_MONTHS = OUTDATED_MONTHS;
  protected readonly OUT_OF_SUPPORT_MONTHS = OUT_OF_SUPPORT_MONTHS;

  getOutOfSupport(dependency: Dependency): boolean {
  let currentDate = new Date();
  let outOfSupportThreshold =  new Date(currentDate.getFullYear(),
    currentDate.getMonth() - OUT_OF_SUPPORT_MONTHS, currentDate.getDate());

    const dependencyDate = new Date(dependency.timestamp);
    return dependencyDate < outOfSupportThreshold;
  }

  getOutDated(dependency: Dependency): boolean {
    let currentDate = new Date();
    let outdatedThreshold =  new Date(currentDate.getFullYear(),
      currentDate.getMonth() - OUTDATED_MONTHS, currentDate.getDate());
    let outOfSupportThreshold =  new Date(currentDate.getFullYear(),
      currentDate.getMonth() - OUT_OF_SUPPORT_MONTHS, currentDate.getDate());

    const dependencyDate = new Date(dependency.timestamp);
    return dependencyDate < outdatedThreshold && dependencyDate > outOfSupportThreshold;
  }
}

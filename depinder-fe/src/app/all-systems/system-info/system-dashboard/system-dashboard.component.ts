import {Component, Input} from '@angular/core';
import { CommonModule } from '@angular/common';
import {MatExpansionModule} from "@angular/material/expansion";
import {Dependency, Project} from "@core/project";
import {MatTableModule} from "@angular/material/table";
import {OperationalRiskComponent} from "./operational-risk/operational-risk.component";
import {OUTDATED_MONTHS} from "@core/constants";

@Component({
  selector: 'app-system-dashboard',
  standalone: true,
  imports: [CommonModule, MatExpansionModule, MatTableModule, OperationalRiskComponent],
  templateUrl: './system-dashboard.component.html',
  styleUrl: './system-dashboard.component.css'
})
export class SystemDashboardComponent {
  @Input() projects: Project[] = [];
  protected readonly OUTDATED_MONTHS = OUTDATED_MONTHS;
}

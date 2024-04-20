import {Component, Input} from '@angular/core';
import { CommonModule } from '@angular/common';
import {OperationalRiskDependencies, ProjectDependency} from "../old-dependencies-table";

@Component({
  selector: 'app-old-dep-details',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './old-dep-details.component.html',
  styleUrl: './old-dep-details.component.css'
})
export class OldDepDetailsComponent {
  @Input() dependency!: OperationalRiskDependencies;

  showAllIndirectDependencies = false;
  showAllDirectDependencies = false;

  getVersions(versions: Set<string>) {
    return Array.from(versions).join(', ');
  }
}

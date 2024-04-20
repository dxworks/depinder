import {Component, Input, OnInit} from '@angular/core';
import { CommonModule } from '@angular/common';
import {extractDomain, navigateToUrl} from "../../../../../common/utils";
import {MatCardModule} from "@angular/material/card";
import {MatListModule} from "@angular/material/list";
import {VulnerableLibrary} from "../vulnerable-library-versions.component";
import {MatTooltipModule} from "@angular/material/tooltip";
import {MatIconModule} from "@angular/material/icon";
import {Dependency} from "@core/project";
import {LibraryInfo} from "@core/library";
import {Vulnerability} from "@core/vulnerability-checker";
import * as semver from 'semver';

@Component({
  selector: 'app-vulnerable-library-details',
  standalone: true,
  imports: [CommonModule, MatCardModule, MatListModule, MatTooltipModule, MatIconModule],
  templateUrl: './vulnerable-library-details.component.html',
  styleUrl: './vulnerable-library-details.component.css'
})
export class VulnerableLibraryDetailsComponent {
  @Input() element!: VulnerableLibrary;

  seeAllIntroducedThrough(element: VulnerableLibrary) {
    element.seeAllIntroducedThrough = !element.seeAllIntroducedThrough;
  }

  seeAllRequestedBy(element: VulnerableLibrary) {
    element.seeAllRequestedBy = !element.seeAllRequestedBy;
  }

  //todo cod copiat, de mutat in service

  getVulnerabilities(version: string): Vulnerability[] {
    return this.element.library.vulnerabilities?.filter(vulnerability =>
      this.isVersionInRange(version, vulnerability.vulnerableRange!)) || [];
  }

  isVersionInRange(version: string, range: string): boolean {
    const conditions = range.split(',').map((part) => part.trim());

    return conditions.every((condition) => {
      const match = condition.match(/(<=|>=|<|>|=)?\s*(.*)/);
      if (!match) {
        console.warn('Invalid version range condition:', condition);
        return false;
      }

      const [, operator, versionRange] = match;

      try {
        switch (operator) {
          case '<':
            return semver.lt(version, versionRange);
          case '<=':
            return semver.lte(version, versionRange);
          case '>':
            return semver.gt(version, versionRange);
          case '>=':
            return semver.gte(version, versionRange);
          case '=':
          case undefined: // Handle the case where no operator is specified, assuming equality
            return semver.eq(version, versionRange);
          default:
            console.warn('Unsupported operator:', operator);
            return false;
        }
      }
      catch (e) {
        console.warn('Error comparing versions:', version, versionRange, e);
        return false;
      }
    });
  }

  protected readonly extractDomain = extractDomain;
  protected readonly navigateToUrl = navigateToUrl;
}

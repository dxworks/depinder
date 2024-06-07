import {Component, Input, OnInit} from '@angular/core';
import {CommonModule} from '@angular/common';
import {Dependency} from "@core/project";
import {LicenceLabelComponent} from "../../../common/standalone/licence-label/licence-label.component";
import {MatTableModule} from "@angular/material/table";
import {MatButtonModule} from "@angular/material/button";
import {MatCheckboxModule} from "@angular/material/checkbox";
import {LicencesService} from "../../../common/services/licences.service";
import {from, mergeMap, toArray} from "rxjs";
import {OtherLicencesComponent} from "./other-licences/other-licences.component";
import {SuggestedLicence} from "@core/licence";
import {ExistingLicenceComponent} from "./existing-licence/existing-licence.component";
import {MatProgressSpinnerModule} from "@angular/material/progress-spinner";

export interface TableElement {
  name: string;
  libraries: Set<string>;
  isChecked: boolean;
  isCustom?: boolean;
  licenceInfo?: any,
  suggestedLicences?: SuggestedLicence[] | null;
}

@Component({
  selector: 'app-system-licences-2',
  standalone: true,
  imports: [CommonModule, LicenceLabelComponent, MatTableModule, MatButtonModule, MatCheckboxModule, OtherLicencesComponent, ExistingLicenceComponent, MatProgressSpinnerModule],
  templateUrl: './system-licences-2.component.html',
  styleUrl: './system-licences-2.component.css'
})
export class SystemLicences2Component implements OnInit {
  @Input() dependencies!: Dependency[];
  @Input() projectIds!: string[];
  @Input() systemId!: string;
  tableElements: TableElement[] = [];
  licenceData: any[] = [];

  constructor(
    private licenceService: LicencesService,
  ) { }

  ngOnInit() {
    this.loadLicences();
  }

  loadLicences() {
    from(this.projectIds).pipe(
      mergeMap(projectId => this.licenceService.getByProjectId(projectId)),
      toArray()
    ).subscribe(data => {
      data.forEach((value, _) => {
        (Array.of(value.body)).forEach((licence, index) => {
          if (licence != null) {
            this.licenceData.push(licence);

            for (let projectLicences of this.licenceData) {
              for (const licence of projectLicences) {
                const existingEntryIndex = this.tableElements.findIndex((element) => element.name === (licence.name ?? licence._id));

                if (existingEntryIndex !== -1) {
                  const existingLibraries = this.tableElements[existingEntryIndex].libraries;
                  const newLibraries = licence.libraries;

                  this.tableElements[existingEntryIndex] = {
                    ...this.tableElements[existingEntryIndex],
                    libraries: new Set([...(existingLibraries ?? []), ...(newLibraries ?? [])])
                  }
                } else {
                  this.tableElements.push({
                    // index: licence.index,
                    name: licence.name ?? licence._id,
                    libraries: new Set(licence.libraries),
                    isChecked: false,
                    isCustom: licence.isCustom,
                    licenceInfo: licence,
                    suggestedLicences: licence.suggestedLicences
                  } as TableElement);
                }
              }
            }
          }
        });
      });
    });
  }

  refreshLicence(ids: Array<string>) {
    this.licenceData = [];
    this.tableElements = [];
    this.loadLicences();
  }

  otherLicences() {
    return this.tableElements.filter(d => d.isCustom === undefined);
  }

  existingLicences() {
    return this.tableElements.filter(d => d.isCustom !== undefined);
  }
}

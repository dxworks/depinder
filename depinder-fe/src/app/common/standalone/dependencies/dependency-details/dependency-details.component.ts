import {Component, Inject, Input, OnInit} from '@angular/core';
import { LibraryInfo, LibraryVersion } from '@core/library';
import { Dependency } from '@core/project';
import {DatePipe, NgForOf, NgIf} from "@angular/common";
import {MAT_DIALOG_DATA, MatDialogRef} from "@angular/material/dialog";
import {ReactiveFormsModule} from "@angular/forms";
import {convertToDateString} from "../../../utils";
import {LicenceLabelComponent} from "../../licence-label/licence-label.component";
import {MatButtonModule} from "@angular/material/button";

@Component({
  standalone: true,
  selector: 'app-dependency-details',
  templateUrl: './dependency-details.component.html',
  imports: [
    NgForOf,
    NgIf,
    DatePipe,
    ReactiveFormsModule,
    LicenceLabelComponent,
    MatButtonModule
  ],
  styleUrls: ['./dependency-details.component.css']
})
export class DependencyDetailsComponent implements OnInit {
  @Input() selectedDependency? : Dependency;
  @Input() libraryInfo?: LibraryInfo;
  @Input() dialogRef?: MatDialogRef<DependencyDetailsComponent, any>;
  selectedVersion?: LibraryVersion;
  displayLimit = 5;

  constructor(
    @Inject(MAT_DIALOG_DATA) public data: any
  ) {
    if (data) {
      this.selectedDependency = data.selectedDependency;
      this.libraryInfo = data.libraryInfo;
    }
  }

  ngOnInit() {
    if (this.dialogRef !== undefined) {
      console.log('dialogRef: ' + this.dialogRef);
      this.dialogRef.close();
    }
    if (this.selectedDependency !== undefined)
      this.findUsedVersion(this.selectedDependency!.version);

    this.libraryInfo?.versions.sort((a, b) => {
      return b.timestamp - a.timestamp;
    });

    console.log('dependency: ' + this.selectedDependency);
    console.log('libraryInfo: ' + this.libraryInfo);
  }

  findUsedVersion(version: string) {
    // if (this.libraryInfo !== undefined) {
      this.selectedVersion = this.libraryInfo?.versions.find(v => v.version === version);
      console.log(this.selectedVersion);
    // }
  }

  loadMore() {
    this.displayLimit += 5; // Increase the limit by 5 each time
  }

  isString(value: any): boolean {
    return typeof value === 'string';
  }

  protected readonly convertToDateString = convertToDateString;
}

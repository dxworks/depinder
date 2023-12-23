import {Component, Inject, Input, OnInit} from '@angular/core';
import { LibraryInfo, LibraryVersion } from '@core/library';
import { Dependency } from '@core/project';
import {DatePipe, NgForOf, NgIf} from "@angular/common";
import {MAT_DIALOG_DATA} from "@angular/material/dialog";
import {ReactiveFormsModule} from "@angular/forms";
import {convertToDateString} from "../../../utils";

@Component({
  standalone: true,
  selector: 'app-dependency-details',
  templateUrl: './dependency-details.component.html',
  imports: [
    NgForOf,
    NgIf,
    DatePipe,
    ReactiveFormsModule
  ],
  styleUrls: ['./dependency-details.component.css']
})
export class DependencyDetailsComponent implements OnInit {
  @Input() selectedDependency? : Dependency;
  @Input() libraryInfo?: LibraryInfo;

  selectedVersion?: LibraryVersion;

  constructor(
    @Inject(MAT_DIALOG_DATA) public data: any
  ) {
    if (data) {
      console.log("aici" + data);
      this.selectedDependency = data.selectedDependency;
      this.libraryInfo = data.libraryInfo;
    }
  }

  ngOnInit() {
    if (this.selectedDependency !== undefined)
      this.findUsedVersion(this.selectedDependency!.version);

    console.log('dependency: ' + this.selectedDependency);
    console.log('libraryInfo: ' + this.libraryInfo);
  }

  findUsedVersion(version: string) {
    // if (this.libraryInfo !== undefined) {
      this.selectedVersion = this.libraryInfo?.versions.find(v => v.version === version);
      console.log(this.selectedVersion);
    // }
  }

  protected readonly convertToDateString = convertToDateString;
}

import {Component, Input, OnInit} from '@angular/core';
import { LibraryInfo, LibraryVersion } from '@core/library';
import { Dependency } from '@core/project';

@Component({
  selector: 'app-dependency-details',
  templateUrl: './dependency-details.component.html',
  styleUrls: ['./dependency-details.component.css']
})
export class DependencyDetailsComponent implements OnInit {
  @Input() selectedDependency? : Dependency;
  @Input() libraryInfo?: LibraryInfo;

  selectedVersion?: LibraryVersion;

  constructor() {}

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
}

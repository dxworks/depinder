import {Component, Input} from '@angular/core';
import {LibraryInfo} from "../../../common/models/library";

@Component({
  selector: 'app-library-details',
  templateUrl: './library-details.component.html',
  styleUrls: ['./library-details.component.css']
})
export class LibraryDetailsComponent {
  @Input() libraryInfo!: LibraryInfo;
  constructor() { }
}

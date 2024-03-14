import {
  ChangeDetectorRef,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  OnInit,
  Output,
  SimpleChanges
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {MatButtonModule} from "@angular/material/button";
import {MatCheckboxModule} from "@angular/material/checkbox";
import {MatTableDataSource, MatTableModule} from "@angular/material/table";
import {TableElement} from "../system-licences-2.component";
import {LicencesService} from "../../../../common/services/licences.service";
import {concatMap, from} from "rxjs";
import {MatIconModule} from "@angular/material/icon";
import {Router} from "@angular/router";

@Component({
  selector: 'app-other-licences',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatCheckboxModule, MatTableModule, MatIconModule],
  templateUrl: './other-licences.component.html',
  styleUrl: './other-licences.component.css'
})
export class OtherLicencesComponent implements OnChanges {
  displayedColumns: string[] = ['check', 'name', 'dependencies', 'other-dependencies', 'actions'];
  //todo change in a better suited type
  @Output() refreshParent: EventEmitter<Array<string>> = new EventEmitter();
  @Input() data: TableElement[] = [];
  dataSource: MatTableDataSource<TableElement> = new MatTableDataSource<TableElement>();

  constructor(
    private licenceService: LicencesService,
    private router: Router,
  ) { }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['data']) {
      this.dataSource = new MatTableDataSource(this.data);
    }
  }

  selectAll() {
    this.dataSource.data.forEach(licence => licence.isChecked = true);
  }

  saveCustomLicences() {
    const licences = this.dataSource.data.filter(licence => licence.isChecked);

    from(licences).pipe(
      concatMap(data =>
        this.licenceService.create({
          _id: data.name,
          name: data.name,
          custom: true,
        })
      )
    ).subscribe({
      next: () => console.log('Licence created'),
      complete: () => console.log('All licences created'),
      error: err => console.error('Error creating a licence', err),
    });
  }

  addAlias(id: string, oldId: string): void {
    if (id !== undefined) {
      this.licenceService.addAlias(oldId, id).subscribe(
        {
          next: data => {
            console.log(data);
            this.refreshParent.emit([id, oldId]);
            console.log("EVENT EMIITED");
          },
          error: error => {
            console.log(error);
          }
        }
      );
    }
    else {
      console.log('No id');
    }
  }

  navigateToSave(id: string) {
    this.router.navigate(['licences/new'], {state: { id: id }}).catch(error => {
      console.error('Error navigating to save page:', error);
    });
  }
}

import {
  Component,
  EventEmitter,
  Input,
  OnChanges, OnInit,
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
import {SelectionModel} from "@angular/cdk/collections";
import {MatSelectModule} from "@angular/material/select";
import {FlexModule} from "@angular/flex-layout";

@Component({
  selector: 'app-other-licences',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatCheckboxModule, MatTableModule, MatIconModule, MatSelectModule, FlexModule],
  templateUrl: './other-licences.component.html',
  styleUrl: './other-licences.component.css'
})
export class OtherLicencesComponent implements OnChanges, OnInit {
  displayedColumns: string[] = ['select', 'name', 'dependencies', 'other-dependencies', 'all-existing-licenses', 'new-license'];
  //todo change in a better suited type
  @Output() refreshParent: EventEmitter<Array<string>> = new EventEmitter();
  @Input() data: TableElement[] = [];
  selection = new SelectionModel<TableElement>(true, []);
  dataSource: MatTableDataSource<TableElement> = new MatTableDataSource<TableElement>();
  licenses: {_id: string, name: string}[] = []
  selectedLicense: Map<string, string | undefined> = new Map<string, string>();

  constructor(
    private licenceService: LicencesService,
    private router: Router,
  ) { }

  ngOnInit() {
    this.licenceService.baseInfo().subscribe({
      next: data => {
        this.licenses = data.body as {_id: string, name: string}[];
      },
      error: error => {
        console.log(error);
      }
    });
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['data']) {
      this.dataSource = new MatTableDataSource(this.data);
      for (let l of this.licenses) {
        this.selectedLicense.set(l._id, undefined);
      }
    }
  }

  isAllSelected() {
    const numSelected = this.selection.selected.length;
    const numRows = this.dataSource.data.length;
    return numSelected === numRows;
  }

  toggleAllRows() {
    if (this.isAllSelected()) {
      this.selection.clear();
      return;
    }

    this.selection.select(...this.dataSource.data);
  }

  checkboxLabel(row?: TableElement): string {
    if (!row) {
      return `${this.isAllSelected() ? 'deselect' : 'select'} all`;
    }
    return `${this.selection.isSelected(row) ? 'deselect' : 'select'} row ${this.getPosition(row.name)}`;
  }

  saveCustomLicences() {
    const licences = this.selection.selected;

    from(licences).pipe(
      concatMap(data =>
        this.licenceService.create({
          _id: data.name,
          name: data.name,
          custom: true,
        })
      )
    ).subscribe({
      next: () => {
        console.log('Licence created');
        this.refreshParent.emit();
      },
      complete: () => console.log('All licences created'),
      error: err => console.error('Error creating a licence', err),
    });
  }

  addAlias(id: string, oldId: string | undefined ): void {
    if (id !== undefined && oldId !== undefined) {
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

  getPosition(id: string) {
    return this.dataSource.data.findIndex((element) => element.name === id) + 1;
  }

  setSelectedLicense(id: string, value: string | undefined): void {
    this.selectedLicense.set(id, value);
  }
}

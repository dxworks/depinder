import {AfterViewInit, ChangeDetectorRef, Component, Input, OnInit, ViewChild} from '@angular/core';
import { CommonModule } from '@angular/common';
import {LicencesService} from "../common/services/licences.service";
import {Licence} from "@core/licence";
import {MatTableDataSource, MatTableModule} from "@angular/material/table";
import {MatIconModule} from "@angular/material/icon";
import {MatRadioModule} from "@angular/material/radio";
import {MatButtonModule} from "@angular/material/button";
import {Router} from "@angular/router";
import {MatPaginator, MatPaginatorModule} from "@angular/material/paginator";
import {MatInputModule} from "@angular/material/input";
import {ToolbarService} from "../common/services/toolbar.service";
import {MatToolbarModule} from "@angular/material/toolbar";
import {MatSort, MatSortModule} from "@angular/material/sort";
import {MatSnackBar} from "@angular/material/snack-bar";
import {delay} from "rxjs";

@Component({
  selector: 'app-all-licences',
  standalone: true,
  imports: [CommonModule, MatTableModule, MatIconModule, MatRadioModule, MatButtonModule, MatPaginatorModule, MatInputModule, MatToolbarModule, MatSortModule],
  templateUrl: './licences.component.html',
  styleUrl: './licences.component.css'
})
export class LicencesComponent implements OnInit {
  @Input() licences?: Licence[];

  licences$: Licence[] = [];
  dataSource: MatTableDataSource<Licence> = new MatTableDataSource<Licence>();
  displayedColumns: string[] = ['_id', 'name', 'isDeprecatedLicenseId', 'isOsiApproved', 'isCustom', 'other_ids'];

  refreshIcon = 'refresh';

  @ViewChild(MatPaginator) paginator!: MatPaginator;
  @ViewChild(MatSort) sort!: MatSort;

  constructor(private licenceService: LicencesService,
              private router: Router,
              protected toolbarService: ToolbarService,
              private snackBar: MatSnackBar,
              private changeDetectorRefs: ChangeDetectorRef)
  { }

  ngOnInit() {
    if (this.licences) {
      this.licences$ = this.licences;
      this.toolbarService.changeTitle(`Licences (${this.licences$.length})`);
      this.dataSource = new MatTableDataSource<Licence>(this.licences$);
    }
    else {
      this.getLicences();
    }
  }

  getLicences() {
    this.licenceService.all().subscribe(
      (res: any) => {
        this.licences$ = (res.body as Licence[]).sort((a, b) => a._id.localeCompare(b._id));
        this.licences$.forEach(licence => {
          licence.other_ids = licence.other_ids?.slice(1)
        });
        this.toolbarService.changeTitle(`Licences (${this.licences$.length})`);

        this.dataSource = new MatTableDataSource<Licence>(this.licences$);
        this.dataSource.paginator = this.paginator;
        this.dataSource.sort = this.sort;

        this.changeDetectorRefs.detectChanges();
      }
    )
  }

  newLicence() {
    this.router.navigate(['licences/new'])
  }

  navigateToLicence(id: string) {
    this.router.navigate([`licences/${id}`])
  }

  applyFilter(event: Event) {
    const filterValue = (event.target as HTMLInputElement).value;
    this.dataSource.filter = filterValue.trim().toLowerCase();

    if (this.dataSource.paginator) {
      this.dataSource.paginator.firstPage();
    }
  }

  refreshLicenses(): void {
    this.refreshIcon = 'sync';

    this.licenceService.refreshAll().subscribe({
      next: (res: any) => {
        this.refreshIcon = 'done';
        setTimeout(() => this.refreshIcon = 'refresh', 5000);
        this.getLicences();
      },
      error: (error: any) => {
        this.snackBar.open(`Error: ${error.message}`, 'Close', { duration: 5000 });
        this.refreshIcon = 'refresh';
      }
    });
  }
}

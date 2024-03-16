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

@Component({
  selector: 'app-all-licences',
  standalone: true,
  imports: [CommonModule, MatTableModule, MatIconModule, MatRadioModule, MatButtonModule, MatPaginatorModule, MatInputModule, MatToolbarModule, MatSortModule],
  templateUrl: './licences.component.html',
  styleUrl: './licences.component.css'
})
export class LicencesComponent implements OnInit, AfterViewInit{
  @Input() licences?: Licence[];
  licences$: Licence[] = [];
  dataSource: MatTableDataSource<Licence> = new MatTableDataSource<Licence>();
  displayedColumns: string[] = ['_id', 'name', 'isDeprecatedLicenseId', 'isOsiApproved', 'custom', 'other_ids'];
  @ViewChild(MatPaginator) paginator!: MatPaginator;
  @ViewChild(MatSort) sort!: MatSort;

  constructor(private licenceService: LicencesService,
              private router: Router,
              protected toolbarService: ToolbarService,
              private cdRef: ChangeDetectorRef) { }

  ngOnInit() {
    if (this.licences) {
      this.licences$ = this.licences;
      this.toolbarService.changeTitle(`Licences (${this.licences$.length})`);
      this.dataSource = new MatTableDataSource<Licence>(this.licences$);
    }
    else this.licenceService.all().subscribe(
      (res: any) => {
        this.licences$ = res.body as Licence[];
        this.toolbarService.changeTitle(`Licences (${this.licences$.length})`);

        this.dataSource = new MatTableDataSource<Licence>(this.licences$);
        this.dataSource.paginator = this.paginator; // assign paginator here
      }
    )
  }

  ngAfterViewInit() {
    this.dataSource.paginator = this.paginator;
    this.dataSource.sort = this.sort;
    this.dataSource.sortingDataAccessor = ((item: Licence, property: string) => {
      console.log(item, property);
      switch (property) {
        case 'isDeprecatedLicenseId': return `${item.isDeprecatedLicenseId}`;
        case 'isOsiApproved': return `${item.isOsiApproved}`;
        case 'custom': return `${item.custom}`;
        case 'other_ids': return `${item.other_ids}`;
        default: return item._id;
      }
    });
    this.cdRef.detectChanges();
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
}

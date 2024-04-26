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

  calculateRelevance(licence: Licence, filterValue: string): number {
    let score = 0;
    const normalizedFilter = filterValue.trim().toLowerCase();

    // Score by 'name'
    if (licence.name!.toLowerCase().includes(normalizedFilter)) {
      score += (1000 - licence.name!.toLowerCase().indexOf(normalizedFilter)) * 3; // Higher weight for 'name'
    }

    // Score by 'id'
    if (licence._id.toLowerCase().includes(normalizedFilter)) {
      score += (1000 - licence._id.toLowerCase().indexOf(normalizedFilter)) * 2; // Medium weight for 'id'
    }

    // Score by 'other_ids'
    if (licence.other_ids) {
      licence.other_ids.forEach(id => {
        if (id.toLowerCase().includes(normalizedFilter)) {
          score += 1000 - id.toLowerCase().indexOf(normalizedFilter); // Lower weight for 'other_ids'
        }
      });
    }

    return score;
  }

  applyFilter(event: Event) {
    const filterValue = (event.target as HTMLInputElement).value;
    this.dataSource.filter = filterValue.trim().toLowerCase();
    const threshold = 500; // Define a suitable threshold based on your scoring system

    if (filterValue) {
      const filteredAndSortedLicences = this.licences$
        .map(licence => ({ licence, score: this.calculateRelevance(licence, filterValue) }))
        .filter(item => item.score >= threshold) // Only include items above the threshold
        .sort((a, b) => b.score - a.score)
        .map(item => item.licence);

      this.dataSource = new MatTableDataSource<Licence>(filteredAndSortedLicences);
      this.dataSource.paginator = this.paginator;
      this.dataSource.sort = this.sort;
    } else {
      this.dataSource = new MatTableDataSource<Licence>(this.licences$);
      this.dataSource.paginator = this.paginator;
      this.dataSource.sort = this.sort;
    }

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

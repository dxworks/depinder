import {Component, OnInit} from '@angular/core';
import { CommonModule } from '@angular/common';
import {ActivatedRoute, Router} from "@angular/router";
import {FormArray, FormBuilder, FormGroup, ReactiveFormsModule, Validators} from "@angular/forms";
import {MatInputModule} from "@angular/material/input";
import {MatCheckboxModule} from "@angular/material/checkbox";
import {MatButtonModule} from "@angular/material/button";
import {LicencesService} from "../../common/services/licences.service";
import {SuggestedLicence} from "@core/licence";
import {MatListModule} from "@angular/material/list";
import {MatIconModule} from "@angular/material/icon";
import {MatToolbarModule} from "@angular/material/toolbar";
import {ToolbarService} from "../../common/services/toolbar.service";
import { switchMap } from 'rxjs/operators';
import { of } from 'rxjs';
import { Location } from '@angular/common';
@Component({
  selector: 'app-add-licence',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, MatInputModule, MatCheckboxModule, MatButtonModule, MatListModule, MatIconModule, MatToolbarModule],
  templateUrl: './add-licence.component.html',
  styleUrl: './add-licence.component.css'
})
//todo change name to AddEditLicenceComponent
export class AddLicenceComponent implements OnInit {
  id?: string;
  licenseForm!: FormGroup;
  suggestedLicenses?: SuggestedLicence[];
  error?: string;
  editMode = false;

  constructor(private router: Router,
              private fb: FormBuilder,
              private licenseService: LicencesService,
              protected toolbarService: ToolbarService,
              private route: ActivatedRoute,
              private location: Location) {
    const currentNavigation = this.router.getCurrentNavigation();
    this.route.data.subscribe(data => {
      if (data['editMode']) {
        this.editMode = true;
      }
    });
    const state = currentNavigation?.extras.state as { id?: string };
    this.id = state?.id;
  }

  ngOnInit() {
    this.licenseForm = this.fb.group({
      reference: [''],
      isDeprecatedLicenseId: [false],
      detailsUrl: [''],
      name: [''],
      _id: [this.id ?? '', [Validators.required]],
      seeAlso: this.fb.array([]),
      isOsiApproved: [false],
      custom: [false],
    });

    if (this.id && this.editMode) {
      this.licenseService.getById(this.id).pipe(
        switchMap(data => {
          let existingInfo: any = data.body;
          console.log("map", existingInfo);
          this.licenseForm.patchValue(
            {
              _id: existingInfo!._id,
              custom: existingInfo!.custom,
              detailsUrl: existingInfo!.detailsUrl,
              isDeprecatedLicenseId: existingInfo!.isDeprecatedLicenseId,
              isOsiApproved: existingInfo!.isOsiApproved,
              name: existingInfo!.name,
              reference: existingInfo!.reference,
            }
          );
          if (!this.editMode && this.id !== undefined) {
            return this.licenseService.findSimilar(this.id);
          } else {
            return of(null);
          }
        })
      ).subscribe(
        data => {
          if (data) {
            this.suggestedLicenses = data.body as SuggestedLicence[];
          }
        },
        error => {
          console.log(error);
        }
      );
    }
  }
  addSeeAlsoUrl(url: string): void {
    this.seeAlso.controls.push(this.fb.control(url));
  }

  onSubmit(): void {
    this.error = undefined;
    this.idControl?.setValue(this.idControl?.value.trim());
    if (this.licenseForm.valid) {
      if (this.editMode) {
        this.edit();
      } else {
        this.create();
      }
    }
    else {
      console.log('No id');
    }
  }

  addAlias(oldId: string): void {
    if (this.id !== undefined) {
        this.licenseService.addAlias(oldId, this.id!).subscribe(
          {
            next: data => {
              console.log(data);
              this.router.navigate(['/licences']);
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

  create(): void {
    this.licenseService.create(this.licenseForm.value).subscribe(
      {
        next: () => {
          console.log('Licence created');
          this.router.navigate(['/licences']);
        },
        error: error => {
          console.log(error);
          this.error = error.toString();
        }
      }
    );
  }

  edit(): void {
    console.log(this.licenseForm.value);
    this.licenseService.patchById(this.id!, this.licenseForm.value).subscribe(
      {
        next: () => {
          console.log('Licence updated');
          this.location.back();
        },
        error: error => {
          console.log(error);
          this.error = error.toString();
        }
      }
    );
  }

  get seeAlso(): FormArray {
    return this.licenseForm.get('seeAlso') as FormArray;
  }


  get idControl() {
    return this.licenseForm.get('_id');
  }
}

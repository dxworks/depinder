import {Component, OnInit} from '@angular/core';
import { CommonModule } from '@angular/common';
import {Router} from "@angular/router";
import {FormArray, FormBuilder, FormGroup, ReactiveFormsModule, Validators} from "@angular/forms";
import {MatInputModule} from "@angular/material/input";
import {MatCheckboxModule} from "@angular/material/checkbox";
import {MatButtonModule} from "@angular/material/button";
import {LicencesService} from "../../common/services/licences.service";
import {SuggestedLicence} from "@core/licence";
import {MatListModule} from "@angular/material/list";

@Component({
  selector: 'app-add-licence',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, MatInputModule, MatCheckboxModule, MatButtonModule, MatListModule],
  templateUrl: './add-licence.component.html',
  styleUrl: './add-licence.component.css'
})
export class AddLicenceComponent implements OnInit {
  id?: string;
  licenseForm!: FormGroup;
  suggestedLicenses?: SuggestedLicence[];
  error?: string;

  constructor(private router: Router,
              private fb: FormBuilder,
              private licenseService: LicencesService) {
    const currentNavigation = this.router.getCurrentNavigation();
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

    if (this.id) {
      this.licenseService.findSimilar(this.id).subscribe(
        {
          next: data => {
            console.log(data);
            this.suggestedLicenses = data.body as SuggestedLicence[];
            // this.licenseForm.patchValue(data.body);
          },
          error: error => {
            console.log(error);
          }
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
      this.licenseService.create(this.licenseForm.value).subscribe(
        {
          next: () => {
            console.log('Licence created');
            this.router.navigate(['/licences']);
          },
          error: error => {
            this.error = error.toString();
          }
        }
      );
    }
    else {
      console.log('No id');
    }
  }

  addAlias(oldId: string): void {
    console.log(oldId);
    console.log(this.id);
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

  get seeAlso(): FormArray {
    return this.licenseForm.get('seeAlso') as FormArray;
  }


  get idControl() {
    return this.licenseForm.get('_id');
  }
}

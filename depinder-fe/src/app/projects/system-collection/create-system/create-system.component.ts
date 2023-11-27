import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import {MatFormFieldModule} from "@angular/material/form-field";
import {
  FormArray, FormBuilder,
  FormControl,
  FormGroup,
  FormGroupDirective,
  NgForm,
  ReactiveFormsModule,
  Validators
} from "@angular/forms";
import {MatInputModule} from "@angular/material/input";
import {ErrorStateMatcher} from "@angular/material/core";
import {MatButtonModule} from "@angular/material/button";
import {SystemsService} from "../../../common/services/systems.service";
import {System} from "@core/system";
import { alphaNumericUnderscoreValidator } from 'src/app/common/validators';

export class MyErrorStateMatcher implements ErrorStateMatcher {
  isErrorState(control: FormControl | null, form: FormGroupDirective | NgForm | null): boolean {
    const isSubmitted = form && form.submitted;
    return !!(control && control.invalid && (control.dirty || control.touched || isSubmitted));
  }
}

@Component({
  selector: 'app-create-system',
  standalone: true,
  imports: [CommonModule, MatFormFieldModule, ReactiveFormsModule, MatInputModule, MatButtonModule],
  templateUrl: './create-system.component.html',
  styleUrl: './create-system.component.css'
})

export class CreateSystemComponent {
  form: FormGroup = this.fb.group({
    id: ['', [Validators.required, alphaNumericUnderscoreValidator]],
    name: ['', Validators.required],
    filePaths: this.fb.array([this.createFilePath()])
  });

  matcher = new MyErrorStateMatcher();

  constructor(private fb: FormBuilder, private systemsService: SystemsService) {}

  get filePaths() {
    return this.form.get('filePaths') as FormArray;
  }

  createFilePath(): FormGroup {
    return this.fb.group({ path: '' });
  }

  addFilePath(): void {
    this.filePaths.push(this.createFilePath());
  }

  removeFilePath(index: number): void {
    this.filePaths.removeAt(index);
  }

  async onSubmit(): Promise<void> {
    if (this.form.valid) {
      const systemData: System = {
        _id: this.form.value.id,
        name: this.form.value.name,
        projectPaths: this.filePaths.value.map((filePath: any) => filePath.path),
        projects: []
      };
      this.systemsService.createSystem(systemData).subscribe(
        res => console.log(res),
        err => console.error(err)
      );
    }
  }
}

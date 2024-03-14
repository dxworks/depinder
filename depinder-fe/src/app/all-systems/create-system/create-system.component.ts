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
import {SystemsService} from "../../common/services/systems.service";
import { alphaNumericUnderscoreValidator } from '../../common/validators';
import {MatIconModule} from "@angular/material/icon";
import {MatToolbarModule} from "@angular/material/toolbar";
import {ToolbarService} from "../../common/services/toolbar.service";

export class MyErrorStateMatcher implements ErrorStateMatcher {
  isErrorState(control: FormControl | null, form: FormGroupDirective | NgForm | null): boolean {
    const isSubmitted = form && form.submitted;
    return !!(control && control.invalid && (control.dirty || control.touched || isSubmitted));
  }
}

@Component({
  selector: 'app-create-system',
  standalone: true,
    imports: [CommonModule, MatFormFieldModule, ReactiveFormsModule, MatInputModule, MatButtonModule, MatIconModule, MatToolbarModule],
  templateUrl: './create-system.component.html',
  styleUrl: './create-system.component.css'
})

export class CreateSystemComponent {
  form!: FormGroup;
  matcher = new MyErrorStateMatcher();

  constructor(private fb: FormBuilder,
              private systemsService: SystemsService,
              protected toolbarService: ToolbarService,) {
    this.initializeForm();
  }

  private initializeForm(): void {
    this.form = this.fb.group({
      id: ['', [Validators.required, alphaNumericUnderscoreValidator]],
      name: ['', Validators.required],
      filePaths: this.fb.array([this.createFilePath()])
    });
  }

  get filePaths(): FormArray {
    return this.form.get('filePaths') as FormArray;
  }

  private createFilePath(): FormGroup {
    return this.fb.group({ path: '' });
  }

  addFilePath(): void {
    this.filePaths.push(this.createFilePath());
  }

  removeFilePath(index: number): void {
    this.filePaths.removeAt(index);
  }

  onSubmit(): void {
    if (this.form.valid) {
      const systemData = this.getSystemData();
      this.systemsService.createSystem(systemData).subscribe(
        res => console.log(res),
        err => console.log(err)
      );
    } else {
      alert('Form is invalid')
    }
  }

  private getSystemData(): any {
    return {
      _id: this.form.value.id,
      name: this.form.value.name,
      projectPaths: this.getValidFilePaths(),
    };
  }

  private getValidFilePaths(): string[] {
    return this.filePaths.value
      .map((filePath: any) => filePath.path)
      .filter((path: any) => path);
  }
}

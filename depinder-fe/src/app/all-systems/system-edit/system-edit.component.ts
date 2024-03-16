import {Component, OnInit} from '@angular/core';
import { CommonModule } from '@angular/common';
import {FormArray, FormBuilder, FormGroup, FormsModule, ReactiveFormsModule, Validators} from "@angular/forms";
import {MatButtonModule} from "@angular/material/button";
import {MatFormFieldModule} from "@angular/material/form-field";
import {MatInputModule} from "@angular/material/input";
import {SystemsService} from "../../common/services/systems.service";
import {MyErrorStateMatcher} from "../create-system/create-system.component";
import {System, SystemRun} from "@core/system";
import {ActivatedRoute, Router} from "@angular/router";
import {MatIconModule} from "@angular/material/icon";
import {MatSnackBar} from "@angular/material/snack-bar";
import {MatToolbarModule} from "@angular/material/toolbar";
import {ToolbarService} from "../../common/services/toolbar.service";

@Component({
  selector: 'app-system-edit',
  standalone: true,
  imports: [CommonModule, FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, ReactiveFormsModule, MatIconModule, MatToolbarModule],
  templateUrl: './system-edit.component.html',
  styleUrl: './system-edit.component.css'
})
export class SystemEditComponent implements OnInit {
  form!: FormGroup;
  matcher = new MyErrorStateMatcher();
  id: string | undefined;
  system: System | undefined;
  deletedProjects: string[] = [];
  existingProjects: string[] = [];

  constructor(private fb: FormBuilder,
              private systemsService: SystemsService,
              private route: ActivatedRoute,
              private router: Router,
              private _snackBar: MatSnackBar,
              protected toolbarService: ToolbarService) {
    this.route.params.subscribe(params => {
      this.id = params['id'];
    });
    this.initializeForm();
  }

  ngOnInit(): void {
    if (this.id) {
      this.systemsService.find(this.id).subscribe(
        (system: System) => {
          this.system = system;
          this.form.patchValue({"name": system.name});
          this.existingProjects = this.latestRun?.projects ?? [];
        }
      )
    }
  }

  get latestRun(): SystemRun | undefined {
    return this.system?.runs.sort((a, b) => b.date - a.date)[0];
  }

  private initializeForm(): void {
    this.form = this.fb.group({
      name: ['', Validators.required],
      filePaths: this.fb.array([])
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

      this.systemsService.updateSystem(
        systemData._id,
        systemData.name,
        systemData.projectPaths,
        systemData.deletedProjects
      ).subscribe(
        {
          next: () => {
            this.openSnackBar("System updated!");
            this.router.navigate(['/..'])
          },
          error: (error: any) => {
            this.openSnackBar("Error updating system!");
            console.log(error);
          }
        }
      );
    } else {
      this.openSnackBar("Form invalid!");
    }
  }

  openSnackBar(message: string) {
    this._snackBar.open(message)._dismissAfter(2000)
  }

  private getSystemData(): any {
    return {
      _id: this.id,
      name: this.form.value.name,
      projectPaths: this.getValidFilePaths(),
      deletedProjects: this.deletedProjects,
    };
  }

  private getValidFilePaths(): string[] {
    let filePathsArray = this.form.get('filePaths') as FormArray;

    return filePathsArray.value
      .map((filePath: any) => filePath.path)
      .filter((path: any) => path);
  }

  deleteProject(projectId: string): void {
    this.existingProjects = this.existingProjects.filter(id => id !== projectId);
    this.deletedProjects.push(projectId);
  }

  deleteSystem(): void {
    if (this.system) {
      this.systemsService.deleteSystem(this.system._id).subscribe(
        {
          next: () => {
            this.openSnackBar("System deleted!");
            this.router.navigate(['/..'])
          },
          error: (error: any) => {
            this.openSnackBar("Error deleting system!");
            console.log(error);
          }
        }
      );
    }
  }
}

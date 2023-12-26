import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AddLicenceComponent } from './add-licence.component';

describe('AddLicenceComponent', () => {
  let component: AddLicenceComponent;
  let fixture: ComponentFixture<AddLicenceComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AddLicenceComponent]
    })
    .compileComponents();
    
    fixture = TestBed.createComponent(AddLicenceComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
